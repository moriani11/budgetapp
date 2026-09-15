import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Expense } from "./types";

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

// Automatische categorisatie op basis van transactienaam en omschrijving
export function autoCategorize(name: string, description: string = ""): string {
    const text = `${name} ${description}`.toLowerCase();

    if (
        text.includes("colruyt") || text.includes("albert heijn") || text.includes("ah ") ||
        text.includes("delhaize") || text.includes("carrefour") || text.includes("aldi") ||
        text.includes("lidl") || text.includes("jumbo") || text.includes("mcdonald") ||
        text.includes("bakker") || text.includes("slager") || text.includes("restaurant") ||
        text.includes("deliveroo") || text.includes("takeaway") || text.includes("uber eats") ||
        text.includes("kruidvat") || text.includes("snackbar") || text.includes("spar")
    ) {
        return "Voeding";
    }

    if (
        text.includes("shell") || text.includes("total") || text.includes("q8") ||
        text.includes("esso") || text.includes("bp ") || text.includes("tank") ||
        text.includes("nmbs") || text.includes("de lijn") || text.includes("sncb") ||
        text.includes("uber") || text.includes("bolt") || text.includes("parkmobile") ||
        text.includes("4411") || text.includes("fastned") || text.includes("garage") ||
        text.includes("brandstof")
    ) {
        return "Vervoer";
    }

    if (
        text.includes("huur") || text.includes("engie") || text.includes("luminus") ||
        text.includes("totalenergies") || text.includes("fluvius") || text.includes("telenet") ||
        text.includes("proximus") || text.includes("orange") || text.includes("water") ||
        text.includes("elektriciteit") || text.includes("hypotheek") || text.includes("interkabel")
    ) {
        return "Wonen";
    }

    if (
        text.includes("netflix") || text.includes("spotify") || text.includes("basic-fit") ||
        text.includes("basic fit") || text.includes("kinepolis") || text.includes("cinema") ||
        text.includes("steam") || text.includes("playstation") || text.includes("disney") ||
        text.includes("fit") || text.includes("fitness") || text.includes("ticket") ||
        text.includes("sport") || text.includes("cafe") || text.includes("bar ")
    ) {
        return "Vrije tijd";
    }

    return "Overig";
}

// Haal de RSA private key op uit environment variables of bestand
export function getPrivateKey(): string | null {
    let key = process.env.ENABLE_BANKING_PRIVATE_KEY;
    if (key && key.trim().length > 0) {
        // Herstel eventuele geëscapede newlines
        return key.replace(/\\n/g, "\n").trim();
    }

    const keyPath = process.env.ENABLE_BANKING_KEY_PATH || path.join(__dirname, "private_key.pem");
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
export async function fetchEnableBankingTransactions(accountUid: string, dateFrom?: string): Promise<Partial<Expense>[]> {
    const token = getEnableBankingJWT();
    if (!token) {
        return [];
    }

    try {
        let url = `${ENABLE_BANKING_BASE_URL}/accounts/${accountUid}/transactions`;
        if (dateFrom) {
            url += `?date_from=${dateFrom}`;
        }

        const response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json"
            }
        });

        if (!response.ok) {
            console.error("Enable Banking transactions response niet OK:", response.status, await response.text());
            return [];
        }

        const data = await response.json() as any;
        const txList = data.transactions || [];
        const result: Partial<Expense>[] = [];

        for (const tx of txList) {
            const rawAmount = parseFloat(tx.transaction_amount?.amount || tx.amount || "0");
            const creditDebitIndicator = tx.credit_debit_indicator || (rawAmount < 0 ? "DBIT" : "CRDT");

            if (creditDebitIndicator === "DBIT" || rawAmount < 0) {
                const amount = Math.abs(rawAmount);
                const name = tx.creditor?.name || tx.remittance_information?.[0] || tx.remittance_information_unstructured || "Banktransactie";
                const dateStr = tx.booking_date || tx.value_date || tx.date;
                const date = dateStr ? new Date(dateStr) : new Date();
                const month = date.toISOString().slice(0, 7);
                const description = Array.isArray(tx.remittance_information) ? tx.remittance_information.join(" ") : (tx.remittance_information_unstructured || "");
                const category = autoCategorize(name, description);

                result.push({
                    name,
                    amount,
                    categoryName: category,
                    date,
                    month,
                    recurring: false,
                    inputMethod: "bank",
                    bankTransactionId: tx.entry_reference || tx.transaction_id || `eb_${date.getTime()}_${amount}`
                });
            }
        }

        return result;
    } catch (err) {
        console.error("Fout bij ophalen transacties via Enable Banking:", err);
        return [];
    }
}
