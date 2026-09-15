import { ObjectId } from "mongodb";

export interface User {
    _id?: ObjectId;
    email: string;
    password?: string;
    role: "ADMIN" | "USER";
}

export interface FlashMessage {
    type: "error" | "success";
    message: string;
}

export interface Category {
    _id?: ObjectId;
    name: string;
    color?: string;
    icon?: string;
}

export interface Expense {
    _id?: ObjectId;
    name: string;
    amount: number;
    categoryId?: ObjectId | string;
    categoryName: string;
    date: Date | string;
    month: string; // YYYY-MM
    recurring?: boolean;
    inputMethod?: "voice" | "manual" | "bank";
    bankTransactionId?: string;
}

export interface BankAccount {
    _id?: ObjectId;
    uid: string; // Enable Banking account UID
    bankName: string;
    iban?: string;
    currency?: string;
    accountName?: string;
    sessionId?: string;
    status: "CONNECTED" | "EXPIRED" | "PENDING";
    connectedAt: Date;
    lastSyncedAt?: Date;
}

export interface Income {
    _id?: ObjectId;
    name: string;
    amount: number;
    categoryId?: ObjectId | string;
    categoryName: string;
    date: Date | string;
    month: string; // YYYY-MM
    inputMethod?: "bank";
    bankTransactionId?: string;
}

export interface MonthlySummary {
    month: string;
    income: number;
    expenses: number;
    buffer: number;
}
