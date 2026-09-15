import express, { Express, Request, Response } from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import dotenv from "dotenv";
import OpenAI from "openai";
import {
    connect,
    login,
    getCategories,
    getExpenses,
    getExpenseById,
    createExpense,
    updateExpense,
    deleteExpense,
    getIncome,
    setIncome,
    getMonthlySummary,
    getBankAccounts,
    saveBankAccount,
    updateBankAccount,
    upsertBankAccount,
    deleteBankAccount,
    upsertBankExpense,
    deleteDemoBankData
} from "./database";
import session from "./session";
import { secureMiddleware } from "./secureMiddleware";
import { flashMiddleware } from "./flashMiddleware";
import { Expense, User, BankAccount } from "./types";
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
    const now = new Date();
    return now.toISOString().slice(0, 7);
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

// 1. Dashboard (READ)
app.get("/", secureMiddleware, async (req: Request, res: Response) => {
    const month = (req.query.month as string) || getCurrentMonth();
    const summary = await getMonthlySummary(month);
    const expenses = await getExpenses(month);

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
app.get("/expenses", secureMiddleware, async (req: Request, res: Response) => {
    const month = (req.query.month as string) || "";
    const expenses = await getExpenses(month || undefined);
    res.render("expenses", {
        expenses,
        selectedMonth: month,
        page: "expenses",
        user: req.session.user
    });
});

// 3. Create Expense Form
app.get("/expenses/create", secureMiddleware, async (req: Request, res: Response) => {
    const categories = await getCategories();
    res.render("expense-create", {
        categories,
        defaultDate: new Date().toISOString().slice(0, 10),
        page: "expenses",
        user: req.session.user
    });
});

// 4. Create Expense Action (CREATE)
app.post("/expenses/create", secureMiddleware, async (req: Request, res: Response) => {
    const { name, amount, categoryName, date, recurring } = req.body;
    const dateObj = date ? new Date(date) : new Date();
    const month = date ? date.slice(0, 7) : getCurrentMonth();

    const newExpense: Expense = {
        name,
        amount: parseFloat(amount),
        categoryName: categoryName || "Overig",
        date: dateObj,
        month,
        recurring: recurring === "on" || recurring === true,
        inputMethod: "manual"
    };

    await createExpense(newExpense);
    res.redirect("/expenses");
});

// 5. Update Expense Form
app.get("/expenses/:id/update", secureMiddleware, async (req: Request, res: Response) => {
    const id = req.params.id;
    const expense = await getExpenseById(id);
    if (!expense) {
        res.redirect("/expenses");
        return;
    }
    const categories = await getCategories();
    res.render("expense-update", {
        expense,
        categories,
        page: "expenses",
        user: req.session.user
    });
});

// 6. Update Expense Action (UPDATE)
app.post("/expenses/:id/update", secureMiddleware, async (req: Request, res: Response) => {
    const id = req.params.id;
    const { name, amount, categoryName, date, recurring } = req.body;
    const dateObj = date ? new Date(date) : new Date();
    const month = date ? date.slice(0, 7) : getCurrentMonth();

    await updateExpense(id, {
        name,
        amount: parseFloat(amount),
        categoryName,
        date: dateObj,
        month,
        recurring: recurring === "on" || recurring === true
    });

    res.redirect("/expenses");
});

// 7. Delete Expense Action (DELETE)
app.post("/expenses/:id/delete", secureMiddleware, async (req: Request, res: Response) => {
    const id = req.params.id;
    await deleteExpense(id);
    res.redirect("/expenses");
});

// 8. Income Page & Update
app.get("/income", secureMiddleware, async (req: Request, res: Response) => {
    const month = (req.query.month as string) || getCurrentMonth();
    const incomeDoc = await getIncome(month);
    res.render("income", {
        month,
        amount: incomeDoc ? incomeDoc.amount : 0,
        page: "income",
        user: req.session.user
    });
});

app.post("/income", secureMiddleware, async (req: Request, res: Response) => {
    const { month, amount } = req.body;
    await setIncome(month, parseFloat(amount));
    res.redirect(`/income?month=${month}`);
});

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

            // Haal direct live transacties op
            const transactions = await fetchEnableBankingTransactions(acc.uid);
            for (const tx of transactions) {
                if (tx.name && tx.amount) {
                    const inserted = await upsertBankExpense(tx as Expense);
                    if (inserted) totalImported++;
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
        const transactions = await fetchEnableBankingTransactions(account.uid);
        let importedCount = 0;

        for (const tx of transactions) {
            if (tx.name && tx.amount) {
                const inserted = await upsertBankExpense(tx as Expense);
                if (inserted) importedCount++;
            }
        }

        await updateBankAccount(account.uid, {
            lastSyncedAt: new Date(),
            status: "CONNECTED"
        });

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

app.listen(app.get("port"), async () => {
    try {
        await connect();
        console.log(`Server started on http://localhost:${app.get("port")}`);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
});
