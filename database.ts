import { Collection, MongoClient, ObjectId } from "mongodb";
import dotenv from "dotenv";
import bcrypt from "bcrypt";
import { User, Category, Expense, Income, MonthlySummary, BankAccount } from "./types";
dotenv.config();

export const MONGODB_URI = process.env.MONGO_URI ?? process.env.MONGODB_URI ?? "mongodb://localhost:27017";

export const client = new MongoClient(MONGODB_URI);

const db = client.db("budgetapp");

export const userCollection: Collection<User> = db.collection<User>("users");
export const categoriesCollection: Collection<Category> = db.collection<Category>("categories");
export const expensesCollection: Collection<Expense> = db.collection<Expense>("expenses");
export const incomeCollection: Collection<Income> = db.collection<Income>("income");
export const bankAccountsCollection: Collection<BankAccount> = db.collection<BankAccount>("bank_accounts");

const saltRounds: number = 10;

async function exit() {
    try {
        await client.close();
        console.log("Disconnected from database");
    } catch (error) {
        console.error(error);
    }
    process.exit(0);
}

async function createInitialUser() {
    if (await userCollection.countDocuments() > 0) {
        return;
    }
    let email: string | undefined = process.env.ADMIN_EMAIL ?? "admin@budgetapp.be";
    let password: string | undefined = process.env.ADMIN_PASSWORD ?? "admin123";
    
    await userCollection.insertOne({
        email: email,
        password: await bcrypt.hash(password, saltRounds),
        role: "ADMIN"
    });
    console.log(`Initial admin user created: ${email}`);
}

export async function login(email: string, password: string): Promise<User> {
    if (email === "" || password === "") {
        throw new Error("Email and password required");
    }
    let user: User | null = await userCollection.findOne<User>({ email: email });
    if (user && user.password) {
        if (await bcrypt.compare(password, user.password)) {
            return user;
        } else {
            throw new Error("Password incorrect");
        }
    } else {
        throw new Error("User not found");
    }
}

async function seed() {
    const count = await categoriesCollection.countDocuments();
    if (count === 0) {
        console.log("Database is empty, seeding default categories");
        const defaultCategories: Category[] = [
            { name: "Voeding", color: "#10b981", icon: "🛒" },
            { name: "Vervoer", color: "#3b82f6", icon: "🚗" },
            { name: "Wonen", color: "#8b5cf6", icon: "🏠" },
            { name: "Vrije tijd", color: "#f59e0b", icon: "🎉" },
            { name: "Overig", color: "#6b7280", icon: "📦" }
        ];
        await categoriesCollection.insertMany(defaultCategories);
    }
}

export async function connect() {
    try {
        await client.connect();
        console.log("Connected to database");
        await seed();
        await createInitialUser();
        process.on("SIGINT", exit);
        process.on("SIGTERM", exit);
    } catch (error) {
        console.error(error);
    }
}

export async function getCategories(): Promise<Category[]> {
    return await categoriesCollection.find({}).toArray();
}

export async function getExpenses(month?: string): Promise<Expense[]> {
    if (!month) {
        return await expensesCollection.find({}).sort({ date: -1 }).toArray();
    }

    // 1. Eenmalige uitgaven voor deze specifieke maand
    const regularExpenses = await expensesCollection.find({
        month: month,
        recurring: { $ne: true }
    }).toArray();

    // 2. Vaste uitgaven die actief zijn vanaf hun ingevoerde maand
    const recurringExpenses = await expensesCollection.find({
        recurring: true,
        month: { $lte: month }
    }).toArray();

    // Zorg dat de weergavedatum van vaste uitgaven overeenkomt met de geselecteerde maand
    const recurringForMonth = recurringExpenses.map(exp => {
        const origDate = new Date(exp.date);
        const day = isNaN(origDate.getDate()) ? 1 : origDate.getDate();
        const [yearStr, monthStr] = month.split("-");
        const monthDate = new Date(parseInt(yearStr), parseInt(monthStr) - 1, day);
        return {
            ...exp,
            date: monthDate,
            month: month
        };
    });

    return [...recurringForMonth, ...regularExpenses].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

export async function getRecurringExpenses(): Promise<Expense[]> {
    return await expensesCollection.find({ recurring: true }).sort({ date: -1 }).toArray();
}

export async function getExpenseById(id: string): Promise<Expense | null> {
    return await expensesCollection.findOne({ _id: new ObjectId(id) });
}

export async function createExpense(expense: Expense) {
    return await expensesCollection.insertOne(expense);
}

export async function updateExpense(id: string, expense: Partial<Expense>) {
    return await expensesCollection.updateOne({ _id: new ObjectId(id) }, { $set: expense });
}

export async function deleteExpense(id: string) {
    return await expensesCollection.deleteOne({ _id: new ObjectId(id) });
}

export async function getIncome(month?: string): Promise<Income[]> {
    if (!month) {
        return await incomeCollection
            .find({})
            .sort({ date: -1 })
            .toArray();
    }

    return await incomeCollection
        .find({ month })
        .sort({ date: -1 })
        .toArray();
}

// export async function setIncome(month: string, amount: number) {
//     return await incomeCollection.updateOne(
//         { month },
//         { $set: { month, amount } },
//         { upsert: true }
//     );
// }

export async function upsertBankIncome(income: Income): Promise<boolean> {
    if (income.bankTransactionId) {
        const existing = await incomeCollection.findOne({
            bankTransactionId: income.bankTransactionId
        });

        if (existing) {
            return false;
        }
    }

    await incomeCollection.insertOne(income);
    return true;
}

export async function getMonthlySummary(month: string): Promise<MonthlySummary> {
    const incomes = await getIncome(month);

    const totalIncome = incomes.reduce(
        (sum, income) => sum + Number(income.amount),
        0
    );

    const expenses = await getExpenses(month);

    const totalExpenses = expenses.reduce(
        (sum, e) => sum + Number(e.amount),
        0
    );

    return {
        month,
        income: totalIncome,
        expenses: totalExpenses,
        buffer: totalIncome - totalExpenses
    };
}

export async function getBankAccounts(): Promise<BankAccount[]> {
    return await bankAccountsCollection.find({}).sort({ connectedAt: -1 }).toArray();
}

export async function saveBankAccount(account: BankAccount) {
    return await bankAccountsCollection.insertOne(account);
}

export async function updateBankAccount(uid: string, update: Partial<BankAccount>) {
    return await bankAccountsCollection.updateOne({ uid }, { $set: update });
}

export async function upsertBankAccount(account: BankAccount) {
    return await bankAccountsCollection.updateOne(
        { uid: account.uid },
        { $set: account },
        { upsert: true }
    );
}

export async function deleteBankAccount(id: string) {
    return await bankAccountsCollection.deleteOne({ _id: new ObjectId(id) });
}

export async function upsertBankExpense(expense: Expense): Promise<boolean> {
    if (expense.bankTransactionId) {
        const existing = await expensesCollection.findOne({ bankTransactionId: expense.bankTransactionId });
        if (existing) {
            return false;
        }
    }
    await expensesCollection.insertOne(expense);
    return true;
}

export async function deleteDemoBankData() {
    await expensesCollection.deleteMany({ bankTransactionId: { $regex: /^demo_/ } });
    await bankAccountsCollection.deleteMany({ institutionId: "DEMO_BANK" });
}
