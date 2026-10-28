import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const SESSION_COOKIE = 's4hil_admin';

function readCookie(request, name) {
    const cookieHeader = request.headers.cookie || '';
    const entry = cookieHeader.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
    if (!entry) return '';
    try {
        return decodeURIComponent(entry.slice(name.length + 1));
    } catch {
        return '';
    }
}

function verifyPassword(password, encodedHash) {
    const [saltHex, hashBase64] = String(encodedHash || '').split(':');
    if (!saltHex || !hashBase64) return false;
    const expected = Buffer.from(hashBase64, 'base64');
    const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function hashPassword(password) {
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 64);
    return `${salt.toString('hex')}:${hash.toString('base64')}`;
}

export function createAdminAuth({ env = process.env, sessions = new Map() } = {}) {
    const attempts = new Map();

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

    function checkSameOrigin(request, response, next) {
        const origin = request.get('origin');
        let originHost = null;
        try {
            if (origin) originHost = new URL(origin).host;
        } catch {
            return response.status(403).json({ error: 'Request origin is not allowed.' });
        }
        if (originHost && originHost !== request.get('host')) {
            return response.status(403).json({ error: 'Request origin is not allowed.' });
        }
        next();
    }

    function login(request, response) {
        checkSameOrigin(request, response, () => {
            const username = String(request.body?.username || '').slice(0, 100);
            const password = String(request.body?.password || '').slice(0, 200);
            const remoteAddress = request.ip || 'unknown';
            const now = Date.now();
            pruneMaps(now);
            const current = attempts.get(remoteAddress);

            if (current?.lockedUntil > now) {
                return response.status(429).json({ error: 'Too many sign-in attempts. Try again later.' });
            }
            if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD_HASH || !env.SESSION_SECRET) {
                return response.status(503).json({ error: 'Admin access is not configured. See the setup guide.' });
            }

            const valid = username === env.ADMIN_USERNAME && verifyPassword(password, env.ADMIN_PASSWORD_HASH);
            if (!valid) {
                // If previous lockout had expired, restart failure counter
                const baseFailures = (current?.lockedUntil && current.lockedUntil <= now) ? 0 : (current?.failures || 0);
                const failures = baseFailures + 1;
                attempts.set(remoteAddress, {
                    failures,
                    lockedUntil: failures >= 6 ? now + 15 * 60 * 1000 : 0
                });
                return response.status(401).json({ error: 'Username or password is incorrect.' });
            }

            attempts.delete(remoteAddress);
            const sessionId = createHmac('sha256', env.SESSION_SECRET).update(randomBytes(32)).digest('hex');
            sessions.set(sessionId, { username, expiresAt: now + SESSION_LIFETIME_MS });
            const secure = env.NODE_ENV === 'production' ? '; Secure' : '';
            response.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_LIFETIME_MS / 1000}${secure}`);
            response.json({ username });
        });
    }

    function requireAdmin(request, response, next) {
        const sessionId = readCookie(request, SESSION_COOKIE);
        const session = sessions.get(sessionId);
        if (!session || session.expiresAt <= Date.now()) {
            if (sessionId) sessions.delete(sessionId);
            return response.status(401).json({ error: 'Admin sign-in is required.' });
        }
        request.admin = { username: session.username };
        next();
    }

    function logout(request, response) {
        checkSameOrigin(request, response, () => {
            const sessionId = readCookie(request, SESSION_COOKIE);
            if (sessionId) sessions.delete(sessionId);
            response.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${env.NODE_ENV === 'production' ? '; Secure' : ''}`);
            response.status(204).end();
        });
    }

    function session(request, response) {
        const sessionId = readCookie(request, SESSION_COOKIE);
        const value = sessions.get(sessionId);
        if (!value || value.expiresAt <= Date.now()) {
            if (sessionId) sessions.delete(sessionId);
            return response.json({ authenticated: false });
        }
        response.json({ authenticated: true, username: value.username });
    }

    return { login, logout, session, requireAdmin };
}