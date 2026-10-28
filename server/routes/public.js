import { Router } from 'express';
import { randomUUID } from 'node:crypto';

const BOOK_FIELDS = `
    b.id, b.title, b.slug, b.author, b.description, b.price, b.original_price,
    b.category_id, c.name AS category_name, c.slug AS category,
    b.cover_image, b.isbn, b.publisher, b.publication_date, b.page_count,
    b.language, b.stock_quantity, b.featured, b.created_at, b.updated_at
`;

const SORTS = {
    featured: 'b.featured DESC, b.id DESC',
    newest: 'b.id DESC',
    title: 'b.title COLLATE NOCASE ASC',
    'price-low': 'b.price ASC, b.title COLLATE NOCASE ASC',
    'price-high': 'b.price DESC, b.title COLLATE NOCASE ASC'
};

function safeGuestId(value) {
    const guestId = String(value || '');
    return /^[a-f0-9-]{36}$/i.test(guestId) ? guestId : null;
}

function cleanText(value, maxLength) {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function publicBook(db, id) {
    return db.prepare(`SELECT ${BOOK_FIELDS} FROM books b JOIN categories c ON c.id = b.category_id WHERE b.id = ?`).get(id);
}

export function createPublicRouter({ db, customerAuth }) {
    const router = Router();
    router.use(customerAuth.attach);

    router.get('/health', (request, response) => response.json({ status: 'ok' }));

    router.post('/auth/signup', customerAuth.signup);
    router.post('/auth/login', customerAuth.login);
    router.post('/auth/logout', customerAuth.logout);
    router.get('/auth/session', customerAuth.session);

    router.get('/account/orders', customerAuth.requireCustomer, (request, response) => {
        const orders = db.prepare(`
            SELECT id, reference, subtotal, shipping, total, status, payment_status, created_at
            FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
        `).all(request.user.id);
        const orderIds = orders.map((order) => order.id);
        const items = orderIds.length
            ? db.prepare(`SELECT order_id, title_snapshot AS title, unit_price, quantity FROM order_items WHERE order_id IN (${orderIds.map(() => '?').join(',')}) ORDER BY id`).all(...orderIds)
            : [];
        const itemsByOrder = new Map();
        for (const item of items) {
            if (!itemsByOrder.has(item.order_id)) itemsByOrder.set(item.order_id, []);
            itemsByOrder.get(item.order_id).push(item);
        }
        response.json({ orders: orders.map((order) => ({ ...order, items: itemsByOrder.get(order.id) || [] })) });
    });

    router.get('/categories', (request, response) => {
        const categories = db.prepare(`
            SELECT c.id, c.name, c.slug, c.description, c.image, COUNT(b.id) AS book_count
            FROM categories c LEFT JOIN books b ON b.category_id = c.id
            GROUP BY c.id ORDER BY c.name COLLATE NOCASE
        `).all();
        response.json({ categories });
    });

    router.get('/books/featured', (request, response) => {
        const limit = Math.min(20, Math.max(1, Number.parseInt(request.query.limit, 10) || 8));
        const books = db.prepare(`
            SELECT ${BOOK_FIELDS} FROM books b JOIN categories c ON c.id = b.category_id
            WHERE b.featured = 1 ORDER BY b.id LIMIT ?
        `).all(limit);
        response.json({ books });
    });

    router.get('/books', (request, response) => {
        const page = Math.max(1, Number.parseInt(request.query.page, 10) || 1);
        const limit = Math.min(48, Math.max(1, Number.parseInt(request.query.limit, 10) || 12));
        const offset = (page - 1) * limit;
        const conditions = [];
        const parameters = [];
        const search = cleanText(request.query.search, 120);
        const category = cleanText(request.query.category, 80);
        const author = cleanText(request.query.author, 100);
        const sort = Object.hasOwn(SORTS, request.query.sort) ? request.query.sort : 'featured';

        if (search) {
            const term = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
            conditions.push(`(b.title LIKE ? ESCAPE '\\' OR b.author LIKE ? ESCAPE '\\' OR b.description LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')`);
            parameters.push(term, term, term, term);
        }
        if (category && category !== 'all') {
            conditions.push('c.slug = ?');
            parameters.push(category);
        }
        if (author) {
            const authorTerm = `%${author.replace(/[\\%_]/g, '\\$&')}%`;
            conditions.push(`b.author LIKE ? ESCAPE '\\'`);
            parameters.push(authorTerm);
        }

        const minimum = request.query.minPrice === undefined ? null : Number(request.query.minPrice);
        const maximum = request.query.maxPrice === undefined ? null : Number(request.query.maxPrice);
        if (minimum !== null) {
            if (!Number.isFinite(minimum) || minimum < 0) return response.status(400).json({ error: 'minPrice must be a non-negative number.' });
            conditions.push('b.price >= ?');
            parameters.push(minimum);
        }
        if (maximum !== null) {
            if (!Number.isFinite(maximum) || maximum < 0) return response.status(400).json({ error: 'maxPrice must be a non-negative number.' });
            conditions.push('b.price <= ?');
            parameters.push(maximum);
        }
        if (minimum !== null && maximum !== null && minimum > maximum) {
            return response.status(400).json({ error: 'minPrice cannot be greater than maxPrice.' });
        }
        if (request.query.available === 'true') conditions.push('(b.stock_quantity > 0 OR b.stock_quantity IS NULL)');

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        const total = db.prepare(`SELECT COUNT(*) AS count FROM books b JOIN categories c ON c.id = b.category_id ${where}`).get(...parameters).count;
        const books = db.prepare(`
            SELECT ${BOOK_FIELDS} FROM books b JOIN categories c ON c.id = b.category_id
            ${where} ORDER BY ${SORTS[sort]} LIMIT ? OFFSET ?
        `).all(...parameters, limit, offset);

        response.json({ books, page, limit, total, pages: Math.ceil(total / limit), sort });
    });

    router.get('/books/:id', (request, response) => {
        const id = Number(request.params.id);
        if (!Number.isSafeInteger(id) || id < 1) return response.status(400).json({ error: 'Book ID must be a positive integer.' });
        const book = publicBook(db, id);
        if (!book) return response.status(404).json({ error: 'Book not found.' });
        const related = db.prepare(`
            SELECT ${BOOK_FIELDS} FROM books b JOIN categories c ON c.id = b.category_id
            WHERE b.category_id = ? AND b.id != ? ORDER BY b.featured DESC, b.id LIMIT 4
        `).all(book.category_id, id);
        response.json({ book, related });
    });

    router.get('/wishlist', (request, response) => {
        const guestId = safeGuestId(request.query.guestId);
        if (!guestId) return response.status(400).json({ error: 'A valid guestId is required.' });
        const books = db.prepare(`
            SELECT ${BOOK_FIELDS}, w.created_at AS wishlisted_at
            FROM wishlist w JOIN books b ON b.id = w.book_id JOIN categories c ON c.id = b.category_id
            WHERE w.guest_id = ? ORDER BY w.created_at DESC
        `).all(guestId);
        response.json({ books });
    });

    router.post('/wishlist', (request, response) => {
        const guestId = safeGuestId(request.body?.guestId);
        const bookId = Number(request.body?.bookId);
        if (!guestId || !Number.isSafeInteger(bookId) || bookId < 1) {
            return response.status(400).json({ error: 'A valid guestId and bookId are required.' });
        }
        if (!publicBook(db, bookId)) return response.status(404).json({ error: 'Book not found.' });
        db.prepare('INSERT OR IGNORE INTO wishlist (guest_id, book_id) VALUES (?, ?)').run(guestId, bookId);
        response.status(201).json({ saved: true, bookId });
    });

    router.delete('/wishlist/:bookId', (request, response) => {
        const guestId = safeGuestId(request.query.guestId);
        const bookId = Number(request.params.bookId);
        if (!guestId || !Number.isSafeInteger(bookId) || bookId < 1) {
            return response.status(400).json({ error: 'A valid guestId and bookId are required.' });
        }
        db.prepare('DELETE FROM wishlist WHERE guest_id = ? AND book_id = ?').run(guestId, bookId);
        response.status(204).end();
    });

    router.post('/newsletter', (request, response) => {
        const email = cleanText(request.body?.email, 254).toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response.status(400).json({ error: 'Enter a valid email address.' });
        db.prepare(`
            INSERT INTO newsletter_subscribers (email) VALUES (?)
            ON CONFLICT(email) DO UPDATE SET unsubscribed_at = NULL
        `).run(email);
        response.status(201).json({ subscribed: true });
    });

    router.delete('/newsletter', (request, response) => {
        const email = cleanText(request.body?.email, 254).toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response.status(400).json({ error: 'Enter a valid email address.' });
        db.prepare('UPDATE newsletter_subscribers SET unsubscribed_at = CURRENT_TIMESTAMP WHERE email = ? AND unsubscribed_at IS NULL').run(email);
        response.json({ unsubscribed: true });
    });

    router.post('/contact', (request, response) => {
        const name = cleanText(request.body?.name, 120);
        const email = cleanText(request.body?.email, 254).toLowerCase();
        const subject = cleanText(request.body?.subject || 'Website enquiry', 180);
        const message = cleanText(request.body?.message, 5000);
        if (!name || !subject || message.length < 5) return response.status(400).json({ error: 'Name, subject, and a message of at least five characters are required.' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response.status(400).json({ error: 'Enter a valid email address.' });
        const result = db.prepare('INSERT INTO contact_messages (name, email, subject, message) VALUES (?, ?, ?, ?)').run(name, email, subject, message);
        response.status(201).json({ messageId: Number(result.lastInsertRowid), status: 'new', message: 'Your message is saved for local store review. Email delivery is not configured.' });
    });

    router.post('/orders', (request, response) => {
        const body = request.body || {};
        const customer = {
            firstName: cleanText(body.firstName, 80),
            lastName: cleanText(body.lastName, 80),
            email: cleanText(body.email, 254).toLowerCase(),
            phone: cleanText(body.phone, 40),
            address: cleanText(body.address, 240),
            city: cleanText(body.city, 100),
            postalCode: cleanText(body.postalCode, 20)
        };
        if (Object.values(customer).some((value) => !value)) return response.status(400).json({ error: 'All shipping fields are required.' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) return response.status(400).json({ error: 'Enter a valid email address.' });
        if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 30) return response.status(400).json({ error: 'The order must contain between 1 and 30 different books.' });

        const requested = new Map();
        for (const item of body.items) {
            const id = Number(item?.bookId);
            const quantity = Number(item?.quantity);
            if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 99) {
                return response.status(400).json({ error: 'Each order item needs a valid bookId and quantity from 1 to 99.' });
            }
            const combinedQuantity = (requested.get(id) || 0) + quantity;
            if (combinedQuantity > 99) return response.status(400).json({ error: 'The total quantity of a book cannot exceed 99.' });
            requested.set(id, combinedQuantity);
        }

        const items = [];
        let subtotal = 0;
        for (const [id, quantity] of requested) {
            const book = publicBook(db, id);
            if (!book) return response.status(404).json({ error: `Book ${id} was not found.` });
            if (book.stock_quantity !== null && book.stock_quantity < quantity) {
                return response.status(409).json({ error: `${book.title} does not have enough stock for this request.` });
            }
            subtotal += book.price * quantity;
            items.push({ book, quantity });
        }

        const shipping = subtotal > 999 ? 0 : 50;
        const reference = `S4-${randomUUID().slice(0, 8).toUpperCase()}`;
        const fullName = `${customer.firstName} ${customer.lastName}`;

        db.exec('BEGIN IMMEDIATE');
        try {
            const order = db.prepare(`
                INSERT INTO orders (user_id, reference, customer_name, email, phone, address, city, postal_code, subtotal, shipping, total)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(request.user?.id || null, reference, fullName, customer.email, customer.phone, customer.address, customer.city, customer.postalCode, subtotal, shipping, subtotal + shipping);
            const insertItem = db.prepare('INSERT INTO order_items (order_id, book_id, title_snapshot, unit_price, quantity) VALUES (?, ?, ?, ?, ?)');
            const reserveStock = db.prepare('UPDATE books SET stock_quantity = stock_quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND stock_quantity IS NOT NULL AND stock_quantity >= ?');

            for (const item of items) {
                if (item.book.stock_quantity !== null) {
                    const reservation = reserveStock.run(item.quantity, item.book.id, item.quantity);
                    if (reservation.changes !== 1) throw Object.assign(new Error(`${item.book.title} is no longer available in the requested quantity.`), { status: 409 });
                }
                insertItem.run(order.lastInsertRowid, item.book.id, item.book.title, item.book.price, item.quantity);
            }
            db.exec('COMMIT');
            response.status(201).json({
                order: {
                    id: Number(order.lastInsertRowid),
                    reference,
                    status: 'pending_confirmation',
                    paymentStatus: 'not_collected',
                    itemCount: items.reduce((count, item) => count + item.quantity, 0),
                    subtotal,
                    shipping,
                    total: subtotal + shipping
                },
                message: 'Order request saved. Payment has not been collected; the store must confirm this request.'
            });
        } catch (error) {
            db.exec('ROLLBACK');
            if (error.status === 409) return response.status(409).json({ error: error.message });
            throw error;
        }
    });

    return router;
}