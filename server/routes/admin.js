import { Router } from 'express';

const BOOK_FIELDS = `
    b.id, b.title, b.slug, b.author, b.description, b.price, b.original_price,
    b.category_id, c.name AS category_name, c.slug AS category,
    b.cover_image, b.isbn, b.publisher, b.publication_date, b.page_count,
    b.language, b.stock_quantity, b.featured, b.created_at, b.updated_at
`;

function text(value, maximum) {
    return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function slugify(value) {
    return text(value, 180).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function optionalInteger(value, name, { minimum = 0, nullable = true } = {}) {
    if ((value === undefined || value === null || value === '') && nullable) return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum) throw Object.assign(new Error(`${name} must be an integer of at least ${minimum}.`), { status: 400 });
    return parsed;
}

function bookInput(db, body) {
    const title = text(body.title, 180);
    const author = text(body.author, 140);
    const description = text(body.description, 10000);
    const price = optionalInteger(body.price, 'price', { nullable: false });
    const originalPrice = optionalInteger(body.originalPrice, 'originalPrice');
    const stockQuantity = optionalInteger(body.stockQuantity, 'stockQuantity');
    const pageCount = optionalInteger(body.pageCount, 'pageCount', { minimum: 1 });
    const categoryId = Number(body.categoryId);
    const coverImage = text(body.coverImage, 1000) || null;
    if (!title || !author) throw Object.assign(new Error('Title and author are required.'), { status: 400 });
    if (!Number.isSafeInteger(categoryId) || categoryId < 1) throw Object.assign(new Error('Choose a valid category.'), { status: 400 });
    if (originalPrice !== null && originalPrice < price) throw Object.assign(new Error('originalPrice cannot be lower than price.'), { status: 400 });
    if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(categoryId)) throw Object.assign(new Error('Category not found.'), { status: 400 });
    if (coverImage && !/^https?:\/\//i.test(coverImage) && !/^\/assets\/images\/[a-z0-9._/-]+$/i.test(coverImage)) {
        throw Object.assign(new Error('coverImage must be an HTTP(S) URL or a path under /assets/images/.'), { status: 400 });
    }

    const publicationDate = text(body.publicationDate, 10) || null;
    if (publicationDate && !/^\d{4}-\d{2}-\d{2}$/.test(publicationDate)) {
        throw Object.assign(new Error('publicationDate must use YYYY-MM-DD format.'), { status: 400 });
    }

    return {
        title,
        slug: slugify(body.slug || title),
        author,
        description,
        price,
        originalPrice,
        categoryId,
        coverImage,
        isbn: text(body.isbn, 40) || null,
        publisher: text(body.publisher, 180) || null,
        publicationDate,
        pageCount,
        language: text(body.language, 80) || null,
        stockQuantity,
        featured: body.featured === true || body.featured === 1 || body.featured === 'true' ? 1 : 0
    };
}

function readBook(db, id) {
    return db.prepare(`SELECT ${BOOK_FIELDS} FROM books b JOIN categories c ON c.id = b.category_id WHERE b.id = ?`).get(id);
}

function databaseConflict(response, error) {
    if (error?.errcode === 2067 || String(error?.message || '').includes('UNIQUE constraint failed') || String(error?.code || '').startsWith('ERR_SQLITE_CONSTRAINT')) {
        return response.status(409).json({ error: 'A book with a conflicting title slug or ISBN already exists.' });
    }
    return response.status(500).json({ error: 'Unable to save the book.' });
}

export function createAdminRouter({ db, auth }) {
    const router = Router();

    router.post('/login', auth.login);
    router.post('/logout', auth.logout);
    router.get('/session', auth.session);

    router.use(auth.requireAdmin);

    router.get('/books', (request, response) => {
        const search = text(request.query.search, 120);
        const query = search ? `%${search}%` : null;
        const books = db.prepare(`
            SELECT ${BOOK_FIELDS} FROM books b JOIN categories c ON c.id = b.category_id
            WHERE (? IS NULL OR b.title LIKE ? OR b.author LIKE ? OR b.isbn LIKE ?)
            ORDER BY b.updated_at DESC, b.id DESC
        `).all(query, query, query, query);
        response.json({ books });
    });

    router.post('/books', (request, response) => {
        let book;
        try {
            book = bookInput(db, request.body || {});
        } catch (error) {
            return response.status(error.status || 400).json({ error: error.message });
        }

        try {
            const result = db.prepare(`
                INSERT INTO books
                    (title, slug, author, description, price, original_price, category_id, cover_image, isbn, publisher, publication_date, page_count, language, stock_quantity, featured)
                VALUES
                    (@title, @slug, @author, @description, @price, @originalPrice, @categoryId, @coverImage, @isbn, @publisher, @publicationDate, @pageCount, @language, @stockQuantity, @featured)
            `).run(book);
            response.status(201).json({ book: readBook(db, Number(result.lastInsertRowid)) });
        } catch (error) {
            databaseConflict(response, error);
        }
    });

    router.put('/books/:id', (request, response) => {
        const id = Number(request.params.id);
        if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: 'Book ID must be a positive integer.' });
        if (!readBook(db, id)) return response.status(404).json({ error: 'Book not found.' });

        let book;
        try {
            book = bookInput(db, request.body || {});
        } catch (error) {
            return response.status(error.status || 400).json({ error: error.message });
        }

        try {
            db.prepare(`
                UPDATE books SET
                    title = @title, slug = @slug, author = @author, description = @description,
                    price = @price, original_price = @originalPrice, category_id = @categoryId,
                    cover_image = @coverImage, isbn = @isbn, publisher = @publisher,
                    publication_date = @publicationDate, page_count = @pageCount,
                    language = @language, stock_quantity = @stockQuantity, featured = @featured,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = @id
            `).run({ ...book, id });
            response.json({ book: readBook(db, id) });
        } catch (error) {
            databaseConflict(response, error);
        }
    });

    router.delete('/books/:id', (request, response) => {
        const id = Number(request.params.id);
        if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: 'Book ID must be a positive integer.' });
        const result = db.prepare('DELETE FROM books WHERE id = ?').run(id);
        if (result.changes === 0) return response.status(404).json({ error: 'Book not found.' });
        response.status(204).end();
    });

    router.get('/orders', (request, response) => {
        const orders = db.prepare(`
            SELECT id, reference, customer_name, email, phone, address, city, postal_code,
                   subtotal, shipping, total, status, payment_status, created_at, updated_at
            FROM orders ORDER BY created_at DESC LIMIT 200
        `).all();
        const orderIds = orders.map((order) => order.id);
        const items = orderIds.length
            ? db.prepare(`SELECT order_id, book_id, title_snapshot AS title, unit_price, quantity FROM order_items WHERE order_id IN (${orderIds.map(() => '?').join(',')}) ORDER BY id`).all(...orderIds)
            : [];
        const itemsByOrder = new Map();
        for (const item of items) {
            if (!itemsByOrder.has(item.order_id)) itemsByOrder.set(item.order_id, []);
            itemsByOrder.get(item.order_id).push(item);
        }
        response.json({ orders: orders.map((order) => ({ ...order, items: itemsByOrder.get(order.id) || [] })) });
    });

    router.patch('/orders/:id/status', (request, response) => {
        const id = Number(request.params.id);
        const status = text(request.body?.status, 40);
        const allowed = ['pending_confirmation', 'confirmed', 'cancelled'];
        if (status === 'fulfilled') return response.status(409).json({ error: 'Fulfilment is unavailable until payment and shipping providers are connected.' });
        if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: 'Order ID must be a positive integer.' });
        if (!allowed.includes(status)) return response.status(400).json({ error: 'Choose a supported order status.' });
        const existing = db.prepare('SELECT id, status FROM orders WHERE id = ?').get(id);
        if (!existing) return response.status(404).json({ error: 'Order not found.' });
        if (existing.status === status) return response.json({ order: db.prepare('SELECT id, reference, status, payment_status, updated_at FROM orders WHERE id = ?').get(id) });

        db.exec('BEGIN IMMEDIATE');
        try {
            const items = db.prepare('SELECT book_id, quantity FROM order_items WHERE order_id = ? AND book_id IS NOT NULL').all(id);
            if (existing.status !== 'cancelled' && status === 'cancelled') {
                const restore = db.prepare('UPDATE books SET stock_quantity = stock_quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND stock_quantity IS NOT NULL');
                for (const item of items) restore.run(item.quantity, item.book_id);
            } else if (existing.status === 'cancelled' && status !== 'cancelled') {
                const readStock = db.prepare('SELECT stock_quantity FROM books WHERE id = ?');
                const reserve = db.prepare('UPDATE books SET stock_quantity = stock_quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND stock_quantity IS NOT NULL AND stock_quantity >= ?');
                for (const item of items) {
                    const book = readStock.get(item.book_id);
                    if (book?.stock_quantity === null || !book) continue;
                    const result = reserve.run(item.quantity, item.book_id, item.quantity);
                    if (result.changes !== 1) throw Object.assign(new Error('The order cannot be reactivated because a book no longer has enough stock.'), { status: 409 });
                }
            }
            db.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
            db.exec('COMMIT');
            response.json({ order: db.prepare('SELECT id, reference, status, payment_status, updated_at FROM orders WHERE id = ?').get(id) });
        } catch (error) {
            db.exec('ROLLBACK');
            if (error.status === 409) return response.status(409).json({ error: error.message });
            throw error;
        }
    });

    router.get('/messages', (request, response) => {
        const messages = db.prepare(`
            SELECT id, name, email, subject, message, status, created_at, updated_at
            FROM contact_messages ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'read' THEN 1 ELSE 2 END, created_at DESC
            LIMIT 200
        `).all();
        response.json({ messages });
    });

    router.patch('/messages/:id/status', (request, response) => {
        const id = Number(request.params.id);
        const status = text(request.body?.status, 20);
        if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: 'Message ID must be a positive integer.' });
        if (!['new', 'read', 'archived'].includes(status)) return response.status(400).json({ error: 'Choose a supported message status.' });
        const result = db.prepare('UPDATE contact_messages SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, id);
        if (result.changes === 0) return response.status(404).json({ error: 'Message not found.' });
        response.json({ message: db.prepare('SELECT id, status, updated_at FROM contact_messages WHERE id = ?').get(id) });
    });

    return router;
}