import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase } from './db/database.js';
import { createAdminAuth } from './auth.js';
import { createCustomerAuth } from './customer-auth.js';
import { createPublicRouter } from './routes/public.js';
import { createAdminRouter } from './routes/admin.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function createApp({ db = createDatabase(), env = process.env, sessions = new Map(), customerSessions = new Map() } = {}) {
    const app = express();
    const auth = createAdminAuth({ env, sessions });
    const customerAuth = createCustomerAuth({ db, env, sessions: customerSessions });

    app.disable('x-powered-by');
    app.set('trust proxy', env.NODE_ENV === 'production' ? 1 : false);
    app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
    app.use(express.json({ limit: '100kb' }));
    app.use('/api/admin', createAdminRouter({ db, auth }));
    app.use('/api', createPublicRouter({ db, customerAuth }));

    app.get(['/', '/index.html', '/home', '/pages/index.html'], (request, response) => response.sendFile(resolve(projectRoot, 'index.html')));
    const friendlyPages = ['books', 'cart', 'checkout', 'about', 'contact', 'login', 'signup', 'account', 'wishlist', 'admin', 'terms', 'unsubscribe', 'book'];
    for (const page of friendlyPages) {
        app.get([`/${page}`, `/${page}.html`, `/pages/${page}`, `/pages/${page}.html`], (request, response) => response.sendFile(resolve(projectRoot, 'pages', `${page}.html`)));
    }
    app.use(['/assets', '/pages/assets'], express.static(resolve(projectRoot, 'assets'), { maxAge: env.NODE_ENV === 'production' ? '1h' : 0 }));
    app.use('/pages', express.static(resolve(projectRoot, 'pages'), { maxAge: env.NODE_ENV === 'production' ? '1h' : 0, extensions: ['html'] }));

    app.all('/api/*path', (request, response) => response.status(404).json({ error: 'API route not found.' }));
    app.use((request, response) => response.status(404).send('Page not found.'));

    app.use((error, request, response, next) => {
        if (response.headersSent) return next(error);
        if (error?.type === 'entity.parse.failed') {
            return response.status(400).json({ error: 'Request body must be valid JSON.' });
        }
        console.error('Request failed:', error.message);
        response.status(500).json({ error: 'An unexpected server error occurred.' });
    });

    return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const db = createDatabase();
    const app = createApp({ db });
    const server = createServer(app);
    const port = Number(process.env.PORT) || 3000;

    server.listen(port, () => console.log(`S4HIL STORE listening at http://localhost:${port}`));
    const shutdown = () => server.close(() => {
        db.close();
        process.exit(0);
    });
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}