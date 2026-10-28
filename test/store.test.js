import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from '../server/db/database.js';
import { hashPassword } from '../server/auth.js';
import { createApp } from '../server/app.js';

const database = createDatabase(':memory:');
const app = createApp({
    db: database,
    env: {
        NODE_ENV: 'test',
        ADMIN_USERNAME: 'catalog-admin',
        ADMIN_PASSWORD_HASH: hashPassword('test-admin-password-2026'),
        SESSION_SECRET: 'test-session-secret-long-enough-for-hmac'
    }
});
const server = createServer(app);
let baseUrl;
let adminCookie;

before(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    database.close();
});

async function request(path, { method = 'GET', body, cookie } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...(cookie ? { cookie } : {})
        },
        body: body ? JSON.stringify(body) : undefined
    });
    const payload = response.status === 204 ? null : await response.json();
    return { response, payload };
}

test('public catalog supports database search, filters, and pagination', async () => {
    const allBooks = await request('/api/books?limit=5&page=1');
    assert.equal(allBooks.response.status, 200);
    assert.equal(allBooks.payload.total, 25);
    assert.equal(allBooks.payload.books.length, 5);
    assert.equal(allBooks.payload.pages, 5);

    const search = await request('/api/books?search=quantum');
    assert.equal(search.payload.total, 1);
    assert.equal(search.payload.books[0].title, 'Quantum Dreams');

    const children = await request('/api/books?category=children&maxPrice=200&sort=price-low');
    assert.equal(children.payload.total, 3);
    assert.equal(children.payload.books[0].title, 'Learning Numbers');

    const invalidPriceRange = await request('/api/books?minPrice=500&maxPrice=100');
    assert.equal(invalidPriceRange.response.status, 400);
    const invalidSort = await request('/api/books?sort=constructor');
    assert.equal(invalidSort.response.status, 200);
    assert.equal(invalidSort.payload.sort, 'featured');

    const categories = await request('/api/categories');
    assert.equal(categories.payload.categories.length, 8);
});

test('public product detail and missing-product handling work', async () => {
    const detail = await request('/api/books/4');
    assert.equal(detail.response.status, 200);
    assert.equal(detail.payload.book.title, 'Quantum Dreams');
    assert.equal(detail.payload.related.length, 2);
    assert.equal((await request('/api/books/999')).response.status, 404);
    assert.equal((await request('/api/books/abc')).response.status, 400);
});

test('guest wishlist persists in SQLite and is isolated by guest ID', async () => {
    const guestId = 'c6176f76-2c82-4562-83ad-94437b337100';
    const saved = await request('/api/wishlist', { method: 'POST', body: { guestId, bookId: 4 } });
    assert.equal(saved.response.status, 201);
    await request('/api/wishlist', { method: 'POST', body: { guestId, bookId: 4 } });
    const wishlist = await request(`/api/wishlist?guestId=${guestId}`);
    assert.equal(wishlist.payload.books.length, 1);
    assert.equal(wishlist.payload.books[0].title, 'Quantum Dreams');
    assert.equal((await request('/api/wishlist?guestId=bad')).response.status, 400);
});

test('newsletter subscription and opt-out are persisted and validated', async () => {
    const invalid = await request('/api/newsletter', { method: 'POST', body: { email: 'not-an-email' } });
    assert.equal(invalid.response.status, 400);

    const subscribe = await request('/api/newsletter', { method: 'POST', body: { email: 'reader@example.test' } });
    assert.equal(subscribe.response.status, 201);
    assert.equal(database.prepare('SELECT unsubscribed_at FROM newsletter_subscribers WHERE email = ?').get('reader@example.test').unsubscribed_at, null);

    const unsubscribe = await request('/api/newsletter', { method: 'DELETE', body: { email: 'reader@example.test' } });
    assert.equal(unsubscribe.response.status, 200);
    assert.ok(database.prepare('SELECT unsubscribed_at FROM newsletter_subscribers WHERE email = ?').get('reader@example.test').unsubscribed_at);
});

test('contact requests are validated and only readable through authenticated admin routes', async () => {
    const invalid = await request('/api/contact', { method: 'POST', body: { name: 'Reader', email: 'bad', message: 'Hi' } });
    assert.equal(invalid.response.status, 400);
    const created = await request('/api/contact', {
        method: 'POST',
        body: { name: 'Reader', email: 'reader@example.test', subject: 'Question', message: 'Can you help me find a title?' }
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.status, 'new');
    assert.equal((await request('/api/admin/messages')).response.status, 401);
});

test('customers can sign up without verification, sign in, and view only their orders', async () => {
    const signup = await request('/api/auth/signup', {
        method: 'POST',
        body: { name: 'Account Reader', email: 'account-reader@example.test', password: 'secure-password-2026' }
    });
    assert.equal(signup.response.status, 201);
    assert.equal(signup.payload.user.email, 'account-reader@example.test');
    assert.equal(signup.payload.user.password_hash, undefined);
    const cookie = signup.response.headers.get('set-cookie').split(';')[0];

    const session = await request('/api/auth/session', { cookie });
    assert.equal(session.payload.authenticated, true);
    assert.equal((await request('/api/account/orders')).response.status, 401);
    assert.equal((await request('/api/auth/signup', {
        method: 'POST',
        body: { name: 'Duplicate Reader', email: 'account-reader@example.test', password: 'secure-password-2026' }
    })).response.status, 409);

    const order = await request('/api/orders', {
        method: 'POST',
        cookie,
        body: {
            firstName: 'Account', lastName: 'Reader', email: 'account-reader@example.test', phone: '9999999999',
            address: '1 Account Street', city: 'Mumbai', postalCode: '400001',
            items: [{ bookId: 4, quantity: 1 }]
        }
    });
    assert.equal(order.response.status, 201);
    const history = await request('/api/account/orders', { cookie });
    assert.equal(history.response.status, 200);
    assert.equal(history.payload.orders.length, 1);
    assert.equal(history.payload.orders[0].reference, order.payload.order.reference);

    const login = await request('/api/auth/login', {
        method: 'POST',
        body: { email: 'account-reader@example.test', password: 'secure-password-2026' }
    });
    assert.equal(login.response.status, 200);
    assert.equal((await request('/api/auth/login', {
        method: 'POST',
        body: { email: 'account-reader@example.test', password: 'incorrect-password' }
    })).response.status, 401);
});

test('stock limits reject over-quantity order requests', async () => {
    const categoryId = database.prepare('SELECT id FROM categories WHERE slug = ?').get('fiction').id;
    database.prepare(`INSERT INTO books (id, title, slug, author, description, price, category_id, stock_quantity)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(9900, 'One Copy Only', 'one-copy-only', 'Test Author', 'Stock reservation test.', 100, categoryId, 1);
    try {
        const order = await request('/api/orders', {
            method: 'POST',
            body: {
                firstName: 'Test', lastName: 'Reader', email: 'reader@example.test', phone: '9999999999',
                address: '1 Test Street', city: 'Mumbai', postalCode: '400001',
                items: [{ bookId: 9900, quantity: 2 }]
            }
        });
        assert.equal(order.response.status, 409);
        assert.equal(database.prepare('SELECT stock_quantity FROM books WHERE id = ?').get(9900).stock_quantity, 1);
    } finally {
        database.prepare('DELETE FROM books WHERE id = ?').run(9900);
    }
});

test('checkout validates payload and persists pending, unpaid order', async () => {
    const invalid = await request('/api/orders', { method: 'POST', body: { items: [] } });
    assert.equal(invalid.response.status, 400);

    const checkout = await request('/api/orders', {
        method: 'POST',
        body: {
            firstName: 'Test',
            lastName: 'Reader',
            email: 'reader@example.test',
            phone: '9999999999',
            address: '1 Test Street',
            city: 'Mumbai',
            postalCode: '400001',
            items: [{ bookId: 4, quantity: 2 }]
        }
    });
    assert.equal(checkout.response.status, 201);
    assert.equal(checkout.payload.order.status, 'pending_confirmation');
    assert.equal(checkout.payload.order.paymentStatus, 'not_collected');
    assert.equal(checkout.payload.order.total, 948);
});

test('admin routes deny anonymous users and allow authorized catalog CRUD', async () => {
    const anonymous = await request('/api/admin/books');
    assert.equal(anonymous.response.status, 401);
    const anonymousWrite = await request('/api/admin/books', {
        method: 'POST',
        body: { title: 'Forbidden entry', author: 'Anonymous', price: 1, categoryId: 1 }
    });
    assert.equal(anonymousWrite.response.status, 401);

    const badLogin = await request('/api/admin/login', {
        method: 'POST',
        body: { username: 'catalog-admin', password: 'wrong-password' }
    });
    assert.equal(badLogin.response.status, 401);

    const login = await request('/api/admin/login', {
        method: 'POST',
        body: { username: 'catalog-admin', password: 'test-admin-password-2026' }
    });
    assert.equal(login.response.status, 200);
    adminCookie = login.response.headers.get('set-cookie').split(';')[0];
    const inbox = await request('/api/admin/messages', { cookie: adminCookie });
    assert.equal(inbox.response.status, 200);
    assert.equal(inbox.payload.messages.length, 1);

    const categories = await request('/api/categories');
    const fiction = categories.payload.categories.find((category) => category.slug === 'fiction');
    const created = await request('/api/admin/books', {
        method: 'POST',
        cookie: adminCookie,
        body: { title: 'Test Catalog Entry', author: 'Test Author', price: 250, categoryId: fiction.id, stockQuantity: 3 }
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.payload.book.stock_quantity, 3);
    const bookId = created.payload.book.id;

    const updated = await request(`/api/admin/books/${bookId}`, {
        method: 'PUT',
        cookie: adminCookie,
        body: { title: 'Updated Catalog Entry', author: 'Test Author', price: 275, categoryId: fiction.id, stockQuantity: 3, featured: true }
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.book.price, 275);
    assert.equal((await request(`/api/admin/books/${bookId}`, { method: 'DELETE', cookie: adminCookie })).response.status, 204);

    const stocked = await request('/api/admin/books', {
        method: 'POST',
        cookie: adminCookie,
        body: { title: 'Stock Transition Test', author: 'Test Author', price: 100, categoryId: fiction.id, stockQuantity: 1 }
    });
    const stockBookId = stocked.payload.book.id;
    const order = await request('/api/orders', {
        method: 'POST',
        body: {
            firstName: 'Stock', lastName: 'Reader', email: 'stock@example.test', phone: '9999999999',
            address: '1 Test Street', city: 'Mumbai', postalCode: '400001',
            items: [{ bookId: stockBookId, quantity: 1 }]
        }
    });
    assert.equal(order.response.status, 201);
    assert.equal(database.prepare('SELECT stock_quantity FROM books WHERE id = ?').get(stockBookId).stock_quantity, 0);

    const cancelled = await request(`/api/admin/orders/${order.payload.order.id}/status`, {
        method: 'PATCH', cookie: adminCookie, body: { status: 'cancelled' }
    });
    assert.equal(cancelled.payload.order.status, 'cancelled');
    assert.equal(database.prepare('SELECT stock_quantity FROM books WHERE id = ?').get(stockBookId).stock_quantity, 1);

    database.prepare('UPDATE books SET stock_quantity = 0 WHERE id = ?').run(stockBookId);
    const reactivation = await request(`/api/admin/orders/${order.payload.order.id}/status`, {
        method: 'PATCH', cookie: adminCookie, body: { status: 'confirmed' }
    });
    assert.equal(reactivation.response.status, 409);
    assert.equal(database.prepare('SELECT status FROM orders WHERE id = ?').get(order.payload.order.id).status, 'cancelled');
});

test('the seed migration does not duplicate or restore removed products on restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 's4hil-sqlite-'));
    const path = join(directory, 'store.sqlite');
    try {
        const first = createDatabase(path);
        assert.equal(first.prepare('SELECT COUNT(*) AS count FROM books').get().count, 25);
        first.prepare('DELETE FROM books WHERE id = ?').run(25);
        first.close();

        const restarted = createDatabase(path);
        assert.equal(restarted.prepare('SELECT COUNT(*) AS count FROM books').get().count, 24);
        assert.equal(restarted.prepare('SELECT 1 FROM books WHERE id = ?').get(25), undefined);
        restarted.close();
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('clean URLs, home aliases, and 404 API handling work smoothly', async () => {
    const home = await fetch(`${baseUrl}/home`);
    assert.equal(home.status, 200);
    assert.ok((await home.text()).includes('S4HIL STORE'));

    const pagesIndex = await fetch(`${baseUrl}/pages/index.html`);
    assert.equal(pagesIndex.status, 200);

    const booksPage = await fetch(`${baseUrl}/books`);
    assert.equal(booksPage.status, 200);

    const cartPage = await fetch(`${baseUrl}/cart`);
    assert.equal(cartPage.status, 200);

    const apiNotFound = await request('/api/nonexistent-route');
    assert.equal(apiNotFound.response.status, 404);
    assert.equal(apiNotFound.payload.error, 'API route not found.');
});

test('high price filter and malformed cookies handle gracefully without errors', async () => {
    const highPrice = await request('/api/books?minPrice=1000');
    assert.equal(highPrice.response.status, 200);
    assert.ok(highPrice.payload.books.every((b) => b.price >= 1000));

    // Malformed cookie encoding should be ignored safely without 500 error
    const res = await fetch(`${baseUrl}/api/auth/session`, {
        headers: { cookie: 'customer_session=%E0%A4%A; admin_session=%E0%A4%A' }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.authenticated, false);
});