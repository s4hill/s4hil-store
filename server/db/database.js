import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schema } from './schema.js';
import { seedBooks } from '../data/seed-books.js';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(moduleDirectory, '../..');
const seedVersion = '2026-10-27-books-v1';

function migrateUserOrders(db) {
    const columns = db.prepare('PRAGMA table_info(orders)').all();
    if (!columns.some((column) => column.name === 'user_id')) {
        db.exec('ALTER TABLE orders ADD COLUMN user_id INTEGER REFERENCES users(id) ON UPDATE CASCADE ON DELETE SET NULL');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(user_id, created_at DESC)');
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run('2026-10-27-user-orders-v1');
}

function slugify(value) {
    return String(value)
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}

function applySeed(db) {
    const alreadySeeded = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(seedVersion);
    if (alreadySeeded) return;

    const categories = [...new Set(seedBooks.map((book) => book.category))];
    const categoryNames = {
        fiction: 'Fiction',
        'science-fiction': 'Science Fiction',
        mystery: 'Mystery',
        historical: 'Historical',
        biography: 'Biography',
        'self-help': 'Self Help',
        'non-fiction': 'Non-fiction',
        children: 'Children'
    };

    db.exec('BEGIN IMMEDIATE');
    try {
        const insertCategory = db.prepare('INSERT OR IGNORE INTO categories (name, slug) VALUES (?, ?)');
        for (const category of categories) insertCategory.run(categoryNames[category] || category, category);

        const findCategory = db.prepare('SELECT id FROM categories WHERE slug = ?');
        const insertBook = db.prepare(`
            INSERT OR IGNORE INTO books
                (id, title, slug, author, description, price, category_id, featured)
            VALUES
                (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const book of seedBooks) {
            const category = findCategory.get(book.category);
            if (!category) throw new Error(`Missing seed category: ${book.category}`);
            insertBook.run(
                book.id,
                book.title,
                slugify(book.title),
                book.author,
                book.description || '',
                book.price,
                category.id,
                book.featured ? 1 : 0
            );
        }

        db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(seedVersion);
        db.exec('COMMIT');
    } catch (error) {
        db.exec('ROLLBACK');
        throw error;
    }
}

export function createDatabase(databasePath = process.env.DATABASE_PATH || 'server/data/store.sqlite') {
    const resolvedPath = databasePath === ':memory:'
        ? databasePath
        : (isAbsolute(databasePath) ? databasePath : resolve(projectRoot, databasePath));
    if (resolvedPath !== ':memory:') mkdirSync(dirname(resolvedPath), { recursive: true });

    const db = new DatabaseSync(resolvedPath);
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    if (resolvedPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
    db.exec(schema);
    migrateUserOrders(db);
    applySeed(db);
    return db;
}
