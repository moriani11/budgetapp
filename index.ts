import express, { Express, Request, Response } from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import dotenv from "dotenv";
import OpenAI from "openai";
import {
    connect,
    login,
    getExpenses,
    getIncome,
    getMonthlySummary,
    getYearlySummary,
    getBankAccounts,
    saveBankAccount,
    updateBankAccount,
    upsertBankAccount,
    deleteBankAccount,
    upsertBankExpense,
    upsertBankIncome,
    upsertBankSaving,
    getSavings,
    getTotalSavings,
    deleteDemoBankData,
    getKnownBankTransactionIds
} from "./database";
import session from "./session";
import { secureMiddleware } from "./secureMiddleware";
import { flashMiddleware } from "./flashMiddleware";
import { Expense, Income, Saving, User, BankAccount } from "./types";
import { toMonthKey } from "./dateUtils";
import {
    getASPSPs,
    startAuth,
    createSessionFromCode,
    getEnableBankingAccounts,
    fetchEnableBankingTransactions,
    isEnableBankingConfigured,
    POPULAR_BANKS,
    ASPSP
} from "./bankService";

dotenv.config();

const app: Express = express();

const viewsPath = fs.existsSync(path.join(__dirname, "views"))
    ? path.join(__dirname, "views")
    : path.join(process.cwd(), "views");
const publicPath = fs.existsSync(path.join(__dirname, "public"))
    ? path.join(__dirname, "public")
    : path.join(process.cwd(), "public");

app.set("view engine", "ejs");
app.set("views", viewsPath);

app.use(express.static(publicPath));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(session);
app.use(flashMiddleware);

app.set("port", process.env.PORT || 3000);

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || "dummy",
});

function getCurrentMonth(): string {
    return toMonthKey(new Date());
}

// Authenticatie routes
app.get("/login", (req: Request, res: Response) => {
    res.render("login");
});

app.post("/login", async (req: Request, res: Response) => {
    const email: string = req.body.email;
    const password: string = req.body.password;
    try {
        let user: User = await login(email, password);
        delete user.password;
        req.session.user = user;
        req.session.message = { type: "success", message: "Inloggen geslaagd" };
        res.redirect("/");
    } catch (e: any) {
        req.session.message = { type: "error", message: e.message };
        res.redirect("/login");
    }
});

app.post("/logout", async (req: Request, res: Response) => {
    req.session.destroy(() => {
        res.redirect("/login");
    });
});

// Helper om de laatste 6 maanden te berekenen t.o.v. de huidige maand
function getLastSixMonths(currentMonth: string): string[] {
    const [yearStr, monthStr] = currentMonth.split("-");
    const year = parseInt(yearStr);
    const month = parseInt(monthStr); // 1-12
    const months: string[] = [];

    for (let i = 5; i >= 0; i--) {
        const d = new Date(year, month - 1 - i, 1);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        months.push(`${y}-${m}`);
    }
    return months;
}

// Groepeert een lijst uitgaven/inkomsten per maand en telt de bedragen op.
// Gebruikt op de uitgaven- en inkomstenpagina's om, naast het totaal van
// de geselecteerde maand, ook een totaal per maand te tonen wanneer
// "Toon alles" is gekozen. Nieuwste maand eerst.
function calculateMonthlyTotals(items: { month: string; amount: number }[]): { month: string; total: number }[] {
    const totals: { [month: string]: number } = {};
    for (const item of items) {
        const key = item.month || "Onbekend";
        totals[key] = (totals[key] || 0) + Number(item.amount);
    }
    return Object.keys(totals)
        .sort()
        .reverse()
        .map((month) => ({ month, total: totals[month] }));
}

// 1. Dashboard (READ)
app.get("/", secureMiddleware, async (req: Request, res: Response) => {
    const month = (req.query.month as string) || getCurrentMonth();
    const summary = await getMonthlySummary(month);
    const expenses = await getExpenses(month);

    // Gespaard deze maand (overschrijvingen naar BEHEERDER_IBAN) — apart
    // van summary.expenses, dat bewust GEEN spaarstortingen bevat.
    const savingsThisMonth = await getSavings(month);
    const totalSavedThisMonth = savingsThisMonth.reduce((sum, s) => sum + Number(s.amount), 0);

    // Jaarlijkse cijfers voor het jaar van de geselecteerde maand
    const year = month.split("-")[0];
    const yearlySummary = await getYearlySummary(year);

    // 1. Categorieverdeling voor deze maand
    const categoryTotals: { [key: string]: number } = {};
    for (const exp of expenses) {
        const cat = exp.categoryName || "Overig";
        categoryTotals[cat] = (categoryTotals[cat] || 0) + Number(exp.amount);
    }
    const categoryLabels = Object.keys(categoryTotals);
    const categoryValues = Object.values(categoryTotals);

    // 2. Trend laatste 6 maanden (inkomsten vs uitgaven)
    const sixMonths = getLastSixMonths(month);
    const trendLabels: string[] = [];
    const trendIncome: number[] = [];
    const trendExpenses: number[] = [];

    const monthNames = ["Jan", "Feb", "Mrt", "Apr", "Mei", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dec"];
    for (const m of sixMonths) {
        const sum = await getMonthlySummary(m);
        const [y, mm] = m.split("-");
        trendLabels.push(`${monthNames[parseInt(mm) - 1]} ${y.slice(2)}`);
        trendIncome.push(sum.income);
        trendExpenses.push(sum.expenses);
    }

    res.render("index", {
        summary,
        totalSavedThisMonth,
        yearlySummary,
        expenses,
        currentMonth: month,
        categoryChart: {
            labels: categoryLabels,
            data: categoryValues
        },
        trendChart: {
            labels: trendLabels,
            income: trendIncome,
            expenses: trendExpenses
        },
        page: "dashboard",
        user: req.session.user
    });
});

// 2. Expenses List (READ)
// Standaard tonen we alleen de huidige maand (net als het dashboard),
// zodat uitgaven van verschillende maanden niet door elkaar heen staan.
// Met ?month=all kan de gebruiker bewust alles tonen.
app.get("/expenses", secureMiddleware, async (req: Request, res: Response) => {
    const requestedMonth = (req.query.month as string) || "";
    const showAll = requestedMonth === "all";
    const month = showAll ? "" : (requestedMonth || getCurrentMonth());

    const expenses = await getExpenses(month || undefined);
    const totalAmount = expenses.reduce((sum, e) => sum + Number(e.amount), 0);

    res.render("expenses", {
        expenses,
        selectedMonth: showAll ? "all" : month,
        showAll,
        totalAmount,
        // Alleen nodig (en zinvol) wanneer meerdere maanden tegelijk
        // getoond worden via "Toon alles".
        monthlyTotals: showAll ? calculateMonthlyTotals(expenses) : [],
        page: "expenses",
        user: req.session.user
    });
});

// Uitgaven worden uitsluitend automatisch aangemaakt via de bank-
// synchronisatie (zie syncBankAccount / syncAllBankAccounts). Handmatig
// aanmaken, bewerken en verwijderen van uitgaven is bewust verwijderd.

// 8. Income Page & Update
// Zelfde principe als bij Uitgaven: standaard alleen de huidige maand,
// met ?month=all om alles te tonen.
app.get("/income", secureMiddleware, async (req: Request, res: Response) => {
    const requestedMonth = (req.query.month as string) || "";
    const showAll = requestedMonth === "all";
    const month = showAll ? "" : (requestedMonth || getCurrentMonth());

    const income = await getIncome(month || undefined);
    const totalAmount = income.reduce((sum, i) => sum + Number(i.amount), 0);

    res.render("income", {
        income,
        selectedMonth: showAll ? "all" : month,
        showAll,
        totalAmount,
        monthlyTotals: showAll ? calculateMonthlyTotals(income) : [],
        page: "income",
        user: req.session.user
    });
});

// Spaarpot: overschrijvingen naar BEHEERDER_IBAN, apart bijgehouden van de
// gewone uitgaven. Zelfde maand-kiezer/"Toon alles"-opzet als /expenses en
// /income hierboven.
app.get("/savings", secureMiddleware, async (req: Request, res: Response) => {
    const requestedMonth = (req.query.month as string) || "";
    const showAll = requestedMonth === "all";
    const month = showAll ? "" : (requestedMonth || getCurrentMonth());

    const savings = await getSavings(month || undefined);
    const totalAmount = savings.reduce((sum, s) => sum + Number(s.amount), 0);
    const totalSavings = await getTotalSavings();

    res.render("savings", {
        savings,
        totalSavings,
        selectedMonth: showAll ? "all" : month,
        showAll,
        totalAmount,
        monthlyTotals: showAll ? calculateMonthlyTotals(savings) : [],
        page: "savings",
        user: req.session.user
    });
});

// app.post("/income", secureMiddleware, async (req: Request, res: Response) => {
//     const { month, amount } = req.body;
//     await setIncome(month, parseFloat(amount));
//     res.redirect(`/income?month=${month}`);
// });

async function getFinancialAIAdvice(month: string, question: string): Promise<string> {
    if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === "dummy" || process.env.OPENAI_API_KEY.trim() === "") {
        return "⚠️ Er is momenteel geen geldige OpenAI API key geconfigureerd in je .env bestand.";
    }

    const summary = await getMonthlySummary(month);
    const expenses = await getExpenses(month);

    try {
        const recurringExpenses = expenses.filter(e => e.recurring);
        const regularExpenses = expenses.filter(e => !e.recurring);

        let dataContext = `Financiële gegevens voor maand ${month}:\n`;
        dataContext += `- Maandinkomen: €${summary.income.toFixed(2)}\n`;
        dataContext += `- Totale uitgaven: €${summary.expenses.toFixed(2)}\n`;
        dataContext += `- Overblijvende buffer (saldo): €${summary.buffer.toFixed(2)}\n\n`;

        dataContext += `Vaste maandelijkse uitgaven (${recurringExpenses.length}):\n`;
        if (recurringExpenses.length > 0) {
            dataContext += recurringExpenses.map(e => `  * [VAST] ${e.name} (€${Number(e.amount).toFixed(2)}) - ${e.categoryName}`).join("\n") + "\n\n";
        } else {
            dataContext += `  Geen vaste uitgaven geregistreerd.\n\n`;
        }

        dataContext += `Variabele / eenmalige uitgaven (${regularExpenses.length}):\n`;
        if (regularExpenses.length > 0) {
            dataContext += regularExpenses.map(e => `  * ${e.name} (€${Number(e.amount).toFixed(2)}) - ${e.categoryName}`).join("\n") + "\n\n";
        } else {
            dataContext += `  Geen variabele uitgaven geregistreerd.\n\n`;
        }

        dataContext += `Vraag van de gebruiker: ${question}`;

        const completion = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                {
                    role: "system",
                    content: "Je bent een professionele, vriendelijke persoonlijke financiële adviseur voor een budgetapplicatie. Analyseer de meegeleverde financiële cijfers (inkomsten, vaste lasten, variabele uitgaven, buffer) en beantwoord de vraag van de gebruiker direct, accuraat en overzichtelijk in het Nederlands."
                },
                {
                    role: "user",
                    content: dataContext
                }
            ],
            max_tokens: 600,
            temperature: 0.7
        });

        return completion.choices[0]?.message?.content || "Geen antwoord ontvangen van OpenAI.";
    } catch (err: any) {
        console.error("OpenAI API call mislukt:", err);
        const status = err.status || err.code || "Onbekend";
        const message = err.message || "Er is een fout opgetreden bij het verbinden met OpenAI.";
        return `⚠️ OpenAI API Fout (${status}): ${message}\n\nZorg ervoor dat er actieve credits op je OpenAI account staan op platform.openai.com/billing.`;
    }
}

// 9. AI Advice
app.get("/ai-chat", secureMiddleware, (req: Request, res: Response) => {
    const month = (req.query.month as string) || getCurrentMonth();
    res.render("ai-chat", {
        month,
        question: "",
        answer: null,
        page: "ai-chat",
        user: req.session.user
    });
});

app.post("/ai-chat", secureMiddleware, async (req: Request, res: Response) => {
    const { month, question } = req.body;
    const answer = await getFinancialAIAdvice(month, question);

    res.render("ai-chat", {
        month,
        question,
        answer,
        page: "ai-chat",
        user: req.session.user
    });
});

// 10. Live Bank Integratie (Enable Banking / Open Banking)
app.get("/bank", secureMiddleware, async (req: Request, res: Response) => {
    await deleteDemoBankData();

    const isConfigured = isEnableBankingConfigured();
    const accounts = await getBankAccounts();
    let banks: ASPSP[] = POPULAR_BANKS;

    if (isConfigured) {
        try {
            banks = await getASPSPs("BE");
        } catch (err) {
            banks = POPULAR_BANKS;
        }
    }

    res.render("bank", {
        accounts,
        banks,
        isConfigured,
        page: "bank",
        user: req.session.user
    });
});

app.post("/bank/connect", secureMiddleware, async (req: Request, res: Response) => {
    if (!isEnableBankingConfigured()) {
        req.session.message = {
            type: "error",
            message: "Enable Banking is nog niet geconfigureerd in de environment variables (.env)."
        };
        return res.redirect("/bank");
    }

    const { bankName, country } = req.body;
    const selectedBank = bankName || "KBC Bank";
    const bankCountry = country || "BE";
    const state = crypto.randomBytes(16).toString("hex");

    (req.session as any).bankState = state;
    (req.session as any).bankName = selectedBank;

    const authResult = await startAuth(selectedBank, bankCountry, state);

    if (!authResult || !authResult.url) {
        req.session.message = {
            type: "error",
            message: "Kon geen autorisatiesessie starten bij Enable Banking. Controleer je applicatie-ID en private key."
        };
        return res.redirect("/bank");
    }

    res.redirect(authResult.url);
});

// Zo ver mogelijk terug in de tijd vragen we historische transacties op.
// Enable Banking/de onderliggende bank bepaalt zelf hoeveel historie
// daadwerkelijk beschikbaar is (via PSD2 vaak beperkt tot 90 dagen,
// soms meer afhankelijk van de bank) — we vragen gewoon het maximum aan.
function getMaxHistoryDateFrom(): string {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 2);
    return d.toISOString().slice(0, 10);
}

app.get("/bank/callback", secureMiddleware, async (req: Request, res: Response) => {
    const code = (req.query.code as string) || "";
    const bankName = (req.session as any).bankName || "Bank";

    if (!code) {
        req.session.message = {
            type: "error",
            message: "Geen autorisatiecode ontvangen van de bank."
        };
        return res.redirect("/bank");
    }

    try {
        const sessionResult = await createSessionFromCode(code);

        if (!sessionResult || !sessionResult.accounts || sessionResult.accounts.length === 0) {
            req.session.message = {
                type: "error",
                message: "Sessie aangemaakt, maar geen rekeningen geretourneerd door de bank."
            };
            return res.redirect("/bank");
        }

        let totalImported = 0;

        for (const acc of sessionResult.accounts) {
            const iban = acc.account_id?.iban || acc.account_id?.other || "";
            const bName = acc.servicer?.bank_name || bankName;

            const bankAccount: BankAccount = {
                uid: acc.uid,
                bankName: bName,
                iban: iban,
                currency: acc.currency || "EUR",
                sessionId: sessionResult.sessionId,
                status: "CONNECTED",
                connectedAt: new Date(),
                lastSyncedAt: new Date()
            };

            await upsertBankAccount(bankAccount);

            // Haal direct live transacties op, zo ver mogelijk terug in de tijd
            const knownIds = await getKnownBankTransactionIds();
            const transactions = await fetchEnableBankingTransactions(acc.uid, getMaxHistoryDateFrom(), knownIds);
            for (const tx of transactions) {
                if (tx.name && tx.amount) {
                    const amount = Number(tx.amount);

                    if (tx.isSaving) {
                        // Spaarpot: een overschrijving VANAF deze rekening
                        // NAAR de spaarrekening (DBIT) is een storting en
                        // telt positief mee; geld dat TERUGKOMT vanaf de
                        // spaarrekening (CRDT, bv. een opname) trekken we
                        // juist af van het totaal, in plaats van het als
                        // gewoon inkomen te boeken.
                        const saving: Saving = {
                            name: tx.name,
                            amount: amount < 0 ? Math.abs(amount) : -Math.abs(amount),
                            categoryName: "Spaarpot",
                            date: tx.date || new Date(),
                            month: tx.month || toMonthKey(tx.date ? new Date(tx.date) : new Date()),
                            inputMethod: "bank",
                            bankTransactionId: tx.bankTransactionId
                        };

                        const inserted = await upsertBankSaving(saving);

                        if (inserted) totalImported++;

                    } else if (amount < 0) {
                        // Uitgave
                        const expense = {
                            ...tx,
                            amount: Math.abs(amount)
                        } as Expense;

                        const inserted = await upsertBankExpense(expense);

                        if (inserted) totalImported++;

                    } else if (amount > 0) {
                        // Inkomen
                        const incomeDate = tx.date ? new Date(tx.date) : new Date();

                        const income: Income = {
                            name: tx.name,
                            amount: amount,
                            categoryName: "Inkomen",
                            date: incomeDate,
                            month: toMonthKey(incomeDate),
                            inputMethod: "bank",
                            bankTransactionId: tx.bankTransactionId
                        };

                        const inserted = await upsertBankIncome(income);

                        if (inserted) totalImported++;
                    }
                }
            }
        }

        req.session.message = {
            type: "success",
            message: `Bankrekening succesvol gekoppeld! ${totalImported} transactie(s) direct geïmporteerd en zichtbaar in je dashboard.`
        };
    } catch (err: any) {
        console.error("Fout in bank callback:", err);
        req.session.message = {
            type: "error",
            message: `Fout bij koppelen van bankrekening: ${err.message}`
        };
    }

    res.redirect("/bank");
});

// Haalt nieuwe transacties op voor één bankrekening en slaat ze op.
// Wordt gebruikt door zowel de handmatige "Synchroniseren"-knop
// (/bank/sync/:id) als de automatische uurlijkse achtergrondsynchronisatie.
async function syncBankAccount(account: BankAccount): Promise<number> {
    // Zo ver mogelijk terug in de tijd, zodat ook oudere transacties
    // die nog niet eerder gesynchroniseerd waren alsnog worden opgehaald.
    // Al bekende transacties geven we vooraf mee zodat ze worden
    // overgeslagen vóór categorisatie (zie fetchEnableBankingTransactions),
    // wat vooral bij de automatische uurlijkse sync onnodig herhaald werk
    // (en onnodige AI-aanroepen) voorkomt.
    const knownIds = await getKnownBankTransactionIds();
    const transactions = await fetchEnableBankingTransactions(account.uid, getMaxHistoryDateFrom(), knownIds);
    let importedCount = 0;

    for (const tx of transactions) {
        if (!tx.name || !tx.amount) {
            continue;
        }

        const amount = Number(tx.amount);

        if (tx.isSaving) {
            // Spaarpot: storting (DBIT) telt positief mee, een opname
            // (CRDT, geld terug vanaf de spaarrekening) trekken we af van
            // het totaal in plaats van als gewoon inkomen te boeken.
            const saving: Saving = {
                name: tx.name,
                amount: amount < 0 ? Math.abs(amount) : -Math.abs(amount),
                categoryName: "Spaarpot",
                date: tx.date || new Date(),
                month: tx.month || toMonthKey(tx.date ? new Date(tx.date) : new Date()),
                inputMethod: "bank",
                bankTransactionId: tx.bankTransactionId
            };

            const inserted = await upsertBankSaving(saving);

            if (inserted) {
                importedCount++;
            }
        } else if (amount < 0) {
            const expense: Expense = {
                ...tx,
                amount: Math.abs(amount)
            } as Expense;

            const inserted = await upsertBankExpense(expense);

            if (inserted) {
                importedCount++;
            }
        } else if (amount > 0) {
            const income: Income = {
                name: tx.name,
                amount: amount,
                categoryName: "Inkomen",
                date: tx.date || new Date(),
                month: tx.month || toMonthKey(tx.date ? new Date(tx.date) : new Date()),
                inputMethod: "bank",
                bankTransactionId: tx.bankTransactionId
            };

            const inserted = await upsertBankIncome(income);

            if (inserted) {
                importedCount++;
            }
        }
    }

    await updateBankAccount(account.uid, {
        lastSyncedAt: new Date(),
        status: "CONNECTED"
    });

    return importedCount;
}

let isAutoSyncing = false;

// Synchroniseert alle gekoppelde bankrekeningen. Wordt elk uur automatisch
// aangeroepen (zie setInterval verderop) zodat nieuwe transacties ook
// binnenkomen zonder dat iemand zelf op "Synchroniseren" hoeft te klikken.
// Eén mislukte rekening (bv. verlopen bankkoppeling) mag de andere
// rekeningen niet blokkeren, dus elke rekening wordt apart afgevangen.
async function syncAllBankAccounts(): Promise<void> {
    if (isAutoSyncing) {
        console.log("Automatische banksynchronisatie overgeslagen: vorige run loopt nog.");
        return;
    }

    isAutoSyncing = true;

    try {
        const accounts = await getBankAccounts();

        for (const account of accounts) {
            try {
                const importedCount = await syncBankAccount(account);
                console.log(
                    `Automatische synchronisatie ${account.bankName}: ${importedCount} nieuwe transactie(s).`
                );
            } catch (err: any) {
                console.error(
                    `Automatische synchronisatie mislukt voor ${account.bankName}:`,
                    err.message
                );
            }
        }
    } catch (err: any) {
        console.error("Automatische banksynchronisatie mislukt:", err.message);
    } finally {
        isAutoSyncing = false;
    }
}

app.post("/bank/sync/:id", secureMiddleware, async (req: Request, res: Response) => {
    const accounts = await getBankAccounts();
    const account = accounts.find(a => a._id?.toString() === req.params.id || a.uid === req.params.id);

    if (!account) {
        req.session.message = {
            type: "error",
            message: "Bankrekening niet gevonden."
        };
        return res.redirect("/bank");
    }

    try {
        const importedCount = await syncBankAccount(account);

        req.session.message = {
            type: "success",
            message: `${importedCount} nieuwe transactie(s) gesynchroniseerd van ${account.bankName}.`
        };
    } catch (err: any) {
        req.session.message = {
            type: "error",
            message: `Synchronisatiefout: ${err.message}`
        };
    }

    res.redirect("/bank");
});

app.post("/bank/disconnect/:id", secureMiddleware, async (req: Request, res: Response) => {
    await deleteBankAccount(req.params.id);
    req.session.message = {
        type: "success",
        message: "Bankrekening succesvol ontkoppeld."
    };
    res.redirect("/bank");
});

// PSD2 staat doorgaans maximaal 4 toegangen per 24 uur toe tot
// transactiegegevens zonder dat de gebruiker opnieuw moet inloggen bij de
// bank (Strong Customer Authentication / SCA). Elk uur synchroniseren
// (24x/dag) overschrijdt die grens ruim, waardoor de bank telkens weer om
// een nieuwe login vroeg. Om binnen de SCA-vrijstelling te blijven,
// synchroniseren we hooguit 4 keer per dag: elke 6 uur.
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;

app.listen(app.get("port"), async () => {
    try {
        await connect();
        console.log(`Server started on http://localhost:${app.get("port")}`);

        // Automatische synchronisatie: één keer meteen bij het opstarten,
        // en daarna elke 6 uur opnieuw (zie toelichting bij
        // SYNC_INTERVAL_MS hierboven), zodat nieuwe banktransacties
        // binnenkomen zonder dat iemand handmatig hoeft te synchroniseren
        // én zonder dat de bank steeds opnieuw om een login vraagt.
        syncAllBankAccounts();
        setInterval(syncAllBankAccounts, SYNC_INTERVAL_MS);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
});