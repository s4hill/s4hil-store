import { createHmac, randomBytes, timingSafeEqual, scryptSync } from 'node:crypto';

const COOKIE = 's4hil_customer';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const DUMMY_HASH = '00000000000000000000000000000000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

function readCookie(request) {
    const entry = String(request.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
    if (!entry) return '';
    try {
        return decodeURIComponent(entry.slice(COOKIE.length + 1));
    } catch {
        return '';
    }
}

function checkOrigin(request, response, next) {
    const origin = request.get('origin');
    if (!origin) return next();
    try {
        if (new URL(origin).host !== request.get('host')) return response.status(403).json({ error: 'Request origin is not allowed.' });
    } catch {
        return response.status(403).json({ error: 'Request origin is not allowed.' });
    }
    next();
}

function verifyPassword(password, storedHash) {
    const [saltHex, encoded] = String(storedHash || '').split(':');
    const expected = Buffer.from(encoded || '', 'base64');
    const salt = Buffer.from(saltHex || '', 'hex');
    const actual = scryptSync(String(password), salt.length ? salt : Buffer.alloc(16), expected.length || 64);
    const comparison = expected.length ? expected : Buffer.alloc(64);
    return actual.length === comparison.length && timingSafeEqual(actual, comparison);
}

function safeUser(user) {
    return { id: user.id, name: user.name, email: user.email, created_at: user.created_at };
}

export function createCustomerAuth({ db, env = process.env, sessions = new Map() }) {
    const attempts = new Map();
    const sessionSecret = env.SESSION_SECRET || (env.NODE_ENV === 'production' ? '' : randomBytes(32).toString('hex'));

    function pruneMaps(now) {
        if (attempts.size > 200) {
            for (const [key, val] of attempts.entries()) {
                if (!val.lockedUntil || val.lockedUntil < now) attempts.delete(key);
            }
        }
        if (sessions.size > 100) {
            for (const [key, val] of sessions.entries()) {
                if (val.expiresAt <= now) sessions.delete(key);
            }
        }
    }

    function setSession(user, response) {
        const token = createHmac('sha256', sessionSecret).update(randomBytes(32)).digest('hex');
        sessions.set(token, { user: safeUser(user), expiresAt: Date.now() + SESSION_MS });
        const secure = env.NODE_ENV === 'production' ? '; Secure' : '';
        response.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`);
    }

    function attach(request, response, next) {
        const token = readCookie(request);
        const session = sessions.get(token);
        if (session?.expiresAt > Date.now()) request.user = session.user;
        else if (token) sessions.delete(token);
        next();
    }

    function requireCustomer(request, response, next) {
        attach(request, response, () => {
            if (!request.user) return response.status(401).json({ error: 'Sign in to view this account.' });
            next();
        });
    }

    function signup(request, response) {
        checkOrigin(request, response, () => {
            if (!sessionSecret) return response.status(503).json({ error: 'Customer sessions are not configured on this server.' });
            const name = String(request.body?.name || '').trim().slice(0, 120);
            const email = String(request.body?.email || '').trim().toLowerCase().slice(0, 254);
            const password = String(request.body?.password || '');
            if (name.length < 2) return response.status(400).json({ error: 'Enter your name.' });
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return response.status(400).json({ error: 'Enter a valid email address.' });
            if (password.length < 8 || password.length > 200) return response.status(400).json({ error: 'Password must be at least 8 characters.' });

            const salt = randomBytes(16);
            const passwordHash = `${salt.toString('hex')}:${scryptSync(password, salt, 64).toString('base64')}`;
            try {
                const result = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)').run(name, email, passwordHash);
                const user = db.prepare('SELECT id, name, email, created_at FROM users WHERE id = ?').get(Number(result.lastInsertRowid));
                setSession(user, response);
                response.status(201).json({ user: safeUser(user) });
            } catch (error) {
                if (error?.errcode === 2067 || String(error?.message || '').includes('UNIQUE constraint failed') || String(error?.code || '').startsWith('ERR_SQLITE_CONSTRAINT')) {
                    return response.status(409).json({ error: 'An account with this email already exists.' });
                }
                throw error;
            }
        });
    }

    function login(request, response) {
        checkOrigin(request, response, () => {
            if (!sessionSecret) return response.status(503).json({ error: 'Customer sessions are not configured on this server.' });
            const email = String(request.body?.email || '').trim().toLowerCase().slice(0, 254);
            const password = String(request.body?.password || '').slice(0, 200);
            const key = request.ip || 'unknown';
            const now = Date.now();
            pruneMaps(now);
            const attemptsForIp = attempts.get(key);
            if (attemptsForIp?.lockedUntil > now) return response.status(429).json({ error: 'Too many sign-in attempts. Try again later.' });

            const user = db.prepare('SELECT id, name, email, password_hash, created_at FROM users WHERE email = ?').get(email);
            const valid = verifyPassword(password, user?.password_hash || DUMMY_HASH) && Boolean(user);
            if (!valid) {
                const baseFailures = (attemptsForIp?.lockedUntil && attemptsForIp.lockedUntil <= now) ? 0 : (attemptsForIp?.failures || 0);
                const failures = baseFailures + 1;
                attempts.set(key, { failures, lockedUntil: failures >= 8 ? now + 15 * 60 * 1000 : 0 });
                return response.status(401).json({ error: 'Email or password is incorrect.' });
            }

            attempts.delete(key);
            setSession(user, response);
            response.json({ user: safeUser(user) });
        });
    }

    function logout(request, response) {
        checkOrigin(request, response, () => {
            const token = readCookie(request);
            if (token) sessions.delete(token);
            response.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${env.NODE_ENV === 'production' ? '; Secure' : ''}`);
            response.status(204).end();
        });
    }

    function session(request, response) {
        attach(request, response, () => response.json({ authenticated: Boolean(request.user), user: request.user || null }));
    }

    return { signup, login, logout, session, attach, requireCustomer };
}
