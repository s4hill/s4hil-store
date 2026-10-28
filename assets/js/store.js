(function () {
    const CART_KEY = 's4hil-cart';
    const THEME_KEY = 's4hil-theme';

    function readJSON(key, fallback) {
        try {
            const value = localStorage.getItem(key);
            return value ? JSON.parse(value) : fallback;
        } catch (error) {
            return fallback;
        }
    }

    function getCart() {
        const cart = readJSON(CART_KEY, readJSON('cart', []));
        if (!Array.isArray(cart)) return [];

        return cart.filter((item) => item && Number.isFinite(Number(item.id)))
            .map((item) => ({
                ...item,
                id: Number(item.id),
                price: Math.max(0, Number(item.price) || 0),
                quantity: Math.max(1, Math.floor(Number(item.quantity) || 1))
            }));
    }

    function saveCart(cart) {
        localStorage.setItem(CART_KEY, JSON.stringify(cart));
        localStorage.setItem('cart', JSON.stringify(cart));
        updateCartCount();
        window.dispatchEvent(new CustomEvent('store:cart-changed', { detail: cart }));
    }

    function updateCartCount() {
        const count = getCart().reduce((total, item) => total + item.quantity, 0);
        document.querySelectorAll('#cartCount, [data-cart-count], #mobileCartCount').forEach((badge) => {
            badge.textContent = count > 99 ? '99+' : String(count);
            badge.setAttribute('aria-label', `${count} ${count === 1 ? 'item' : 'items'} in cart`);
            badge.classList.remove('badge-pulse');
            void badge.offsetWidth;
            badge.classList.add('badge-pulse');
        });
    }

    function addToCart(book, quantity = 1) {
        if (!book || !Number.isFinite(Number(book.id))) return;
        const quantityToAdd = Math.max(1, Math.floor(Number(quantity) || 1));
        const cart = getCart();
        const item = cart.find((entry) => entry.id === Number(book.id));
        const currentQuantity = item?.quantity || 0;
        if (book.stock_quantity !== null && book.stock_quantity !== undefined && currentQuantity + quantityToAdd > book.stock_quantity) {
            notify(book.stock_quantity === 0 ? `${book.title} is currently out of stock` : `Only ${book.stock_quantity} copies of ${book.title} are available`);
            return false;
        }
        if (item) {
            item.quantity += quantityToAdd;
        } else {
            cart.push({ ...book, id: Number(book.id), quantity: quantityToAdd });
        }
        saveCart(cart);
        notify(`${book.title} added to your bag`);
        return true;
    }

    function updateQuantity(bookId, change) {
        const cart = getCart();
        const item = cart.find((entry) => entry.id === Number(bookId));
        if (!item) return;
        if (Number(change) > 0 && item.stock_quantity !== null && item.stock_quantity !== undefined && item.quantity + Number(change) > item.stock_quantity) {
            notify(item.stock_quantity === 0 ? `${item.title} is currently out of stock` : `Only ${item.stock_quantity} copies of ${item.title} are available`);
            return;
        }
        item.quantity += Number(change);
        saveCart(cart.filter((entry) => entry.quantity > 0));
    }

    function removeFromCart(bookId) {
        saveCart(getCart().filter((item) => item.id !== Number(bookId)));
    }

    function formatCurrency(amount) {
        return new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: 'INR',
            maximumFractionDigits: 0
        }).format(Number(amount) || 0);
    }

    function escapeXml(value) {
        return String(value).replace(/[&<>"']/g, (character) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&apos;'
        })[character]);
    }

    function escapeHTML(value) {
        return String(value ?? '').replace(/[&<>"']/g, (character) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[character]);
    }

    function bookCoverImage(book) {
        const palettes = {
            fiction: ['#f0d5c6', '#382a54', '#bd8bca'],
            'science-fiction': ['#202448', '#e8e4fa', '#67e8f9'],
            mystery: ['#222631', '#f5f0e8', '#ff8a76'],
            historical: ['#eee1c8', '#3a354e', '#a78bfa'],
            biography: ['#d8e6e2', '#202448', '#67b9c9'],
            'self-help': ['#e8e1f3', '#28274c', '#a78bfa'],
            'non-fiction': ['#d7e4eb', '#202448', '#67e8f9'],
            children: ['#f5d9c8', '#3a3150', '#ff8a76']
        };
        const [paper, ink, accent] = palettes[book.category] || palettes.fiction;
        const title = escapeXml(book.title);
        const author = escapeXml(book.author);
        const category = escapeXml(String(book.category || 'fiction').replace(/-/g, ' '));
        const lines = [];
        let line = '';
        book.title.split(/\s+/).forEach((word) => {
            if (line && `${line} ${word}`.length > 19) {
                lines.push(line);
                line = word;
            } else {
                line = line ? `${line} ${word}` : word;
            }
        });
        if (line) lines.push(line);
        const titleMarkup = lines.slice(0, 3).map((part, index) =>
            `<tspan x="32" dy="${index === 0 ? 0 : 37}">${escapeXml(part)}</tspan>`
        ).join('');
        const titleSize = lines.length > 2 ? 27 : 32;
        const variation = (Number(book.id) || 1) % 4;
        const ornament = variation === 0
            ? `<circle cx="277" cy="183" r="92" fill="${accent}"/><circle cx="277" cy="183" r="61" fill="${paper}" opacity=".72"/>`
            : variation === 1
                ? `<path d="M190 82h170v174H190z" fill="${accent}"/><path d="M220 112h170v174H220z" fill="${paper}" opacity=".58"/>`
                : variation === 2
                    ? `<path d="M0 233 360 78v154L0 388z" fill="${accent}"/><path d="M0 293 360 138v43L0 336z" fill="${paper}" opacity=".7"/>`
                    : `<circle cx="282" cy="178" r="76" fill="${accent}"/><path d="M205 178h154M282 101v154" stroke="${paper}" stroke-width="3" opacity=".8"/>`;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="480" viewBox="0 0 360 480"><rect width="360" height="480" fill="${paper}"/>${ornament}<path d="M20 20h320v440H20z" fill="none" stroke="${ink}" stroke-opacity=".25"/><text x="32" y="58" fill="${ink}" font-family="Arial,sans-serif" font-size="12" font-weight="700" letter-spacing="2">S4HIL / BOOKROOM</text><text x="32" y="300" fill="${ink}" font-family="Georgia,serif" font-size="${titleSize}" font-weight="700">${titleMarkup}</text><text x="32" y="420" fill="${ink}" font-family="Arial,sans-serif" font-size="15">${author}</text><text x="32" y="445" fill="${ink}" font-family="Arial,sans-serif" font-size="10" font-weight="700" letter-spacing="1.5">${category.toUpperCase()}</text></svg>`;
        return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
    }

    function notify(message) {
        let toast = document.querySelector('[data-store-toast]');
        if (!toast) {
            toast = document.createElement('div');
            toast.dataset.storeToast = '';
            toast.className = 'store-toast';
            toast.setAttribute('role', 'status');
            toast.setAttribute('aria-live', 'polite');
            document.body.append(toast);
        }
        toast.textContent = message;
        toast.classList.add('is-visible');
        window.clearTimeout(notify.timeout);
        notify.timeout = window.setTimeout(() => toast.classList.remove('is-visible'), 2800);
    }

    function resolvePageUrl(slug) {
        const isFile = window.location.protocol === 'file:';
        if (!isFile) {
            if (slug === 'index' || slug === 'home') return '/';
            return `/${slug}`;
        }
        const isSubpage = window.location.pathname.includes('/pages/');
        if (slug === 'index' || slug === 'home') return isSubpage ? '../index.html' : 'index.html';
        return isSubpage ? `${slug}.html` : `pages/${slug}.html`;
    }

    function initNavigation() {
        const currentPath = window.location.pathname.toLowerCase();
        let currentKey = 'index';
        if (currentPath.includes('books') || currentPath.includes('book')) currentKey = 'books';
        else if (currentPath.includes('about')) currentKey = 'about';
        else if (currentPath.includes('contact')) currentKey = 'contact';
        else if (currentPath.includes('cart')) currentKey = 'cart';
        else if (currentPath.includes('checkout')) currentKey = 'checkout';
        else if (currentPath.includes('wishlist')) currentKey = 'wishlist';
        else if (currentPath.includes('account')) currentKey = 'account';
        else if (currentPath.includes('login')) currentKey = 'login';
        else if (currentPath.includes('signup')) currentKey = 'signup';
        else if (currentPath.includes('admin')) currentKey = 'admin';
        else if (currentPath.includes('terms')) currentKey = 'terms';
        else if (currentPath.includes('unsubscribe')) currentKey = 'unsubscribe';

        // 1. Universal Home & Brand Link Resolution
        const homeUrl = resolvePageUrl('index');
        document.querySelectorAll('a.nav-brand, .nav-brand').forEach((brandLink) => {
            brandLink.setAttribute('href', homeUrl);
            brandLink.setAttribute('aria-label', 'S4HIL STORE Home');
            if (!brandLink.querySelector('.nav-brand-text')) {
                const text = brandLink.textContent.trim();
                if (text.includes('S4HIL')) {
                    brandLink.innerHTML = '<span class="nav-brand-text">S4HIL</span><span class="nav-brand-badge">STORE</span>';
                }
            }
        });

        // 2. Normalize every navigation link across header and mobile drawer
        const linkMappings = [
            { match: ['home', 'index'], slug: 'index' },
            { match: ['books', 'collection', 'catalog'], slug: 'books' },
            { match: ['about', 'story'], slug: 'about' },
            { match: ['contact'], slug: 'contact' },
            { match: ['cart', 'shopping bag', 'bag'], slug: 'cart' },
            { match: ['wishlist', 'saved'], slug: 'wishlist' },
            { match: ['account', 'profile'], slug: 'account' },
            { match: ['login', 'sign in'], slug: 'login' }
        ];

        document.querySelectorAll('nav a').forEach((link) => {
            if (link.classList.contains('nav-brand') || link.classList.contains('admin-back-link')) return;
            const text = (link.textContent || '').trim().toLowerCase();
            const rawHref = (link.getAttribute('href') || '').toLowerCase();

            for (const map of linkMappings) {
                const matchesText = map.match.some((m) => text === m || text.includes(` ${m}`) || text.startsWith(`${m} `));
                const matchesHref = map.match.some((m) => rawHref.includes(m));
                if (matchesText || matchesHref) {
                    link.setAttribute('href', resolvePageUrl(map.slug));
                    if (map.slug === currentKey) {
                        link.setAttribute('aria-current', 'page');
                        link.classList.add('is-active-nav');
                    } else {
                        link.removeAttribute('aria-current');
                        link.classList.remove('is-active-nav');
                    }
                    break;
                }
            }
        });

        // 2b. If running via file: protocol, normalize footer links for offline browsing
        if (window.location.protocol === 'file:') {
            document.querySelectorAll('footer a').forEach((link) => {
                const text = (link.textContent || '').trim().toLowerCase();
                const rawHref = (link.getAttribute('href') || '').toLowerCase();
                for (const map of linkMappings) {
                    if (map.match.some((m) => text === m || rawHref.includes(m))) {
                        link.setAttribute('href', resolvePageUrl(map.slug));
                        break;
                    }
                }
                if (rawHref.includes('terms')) link.setAttribute('href', resolvePageUrl('terms'));
                if (rawHref.includes('unsubscribe')) link.setAttribute('href', resolvePageUrl('unsubscribe'));
                if (rawHref.includes('admin')) link.setAttribute('href', resolvePageUrl('admin'));
            });
        }

        // 3. Desktop Wishlist Nav Icon in header
        const actions = document.querySelector('nav.sticky .nav-actions, nav.sticky .space-x-3, nav.sticky .space-x-4');
        if (actions && !actions.querySelector('[data-wishlist-nav]')) {
            const wishlist = document.createElement('a');
            wishlist.href = resolvePageUrl('wishlist');
            wishlist.className = 'nav-icon-link';
            wishlist.setAttribute('aria-label', 'Open Wishlist');
            wishlist.dataset.wishlistNav = '';
            wishlist.innerHTML = '<i class="far fa-heart" aria-hidden="true"></i><span class="cart-badge" data-wishlist-count>0</span>';
            const cart = actions.querySelector('a[href*="cart"]');
            if (cart) actions.insertBefore(wishlist, cart.closest('.relative') || cart);
            else actions.prepend(wishlist);
        }

        // 4. Mobile Drawer Integration
        const button = document.getElementById('mobileMenuButton');
        const menu = document.getElementById('mobileMenu');
        if (button && menu) {
            button.setAttribute('aria-label', 'Toggle navigation menu');
            button.setAttribute('aria-expanded', 'false');
            button.setAttribute('aria-controls', 'mobileMenu');

            ensureMobileMenu(menu);

            const toggleDrawer = (force) => {
                const isOpen = typeof force === 'boolean' ? force : !menu.classList.contains('is-open');
                menu.classList.toggle('is-open', isOpen);
                menu.classList.toggle('hidden', !isOpen);
                button.setAttribute('aria-expanded', String(isOpen));
                const icon = button.querySelector('i');
                if (icon) icon.className = isOpen ? 'fas fa-xmark text-2xl' : 'fas fa-bars text-2xl';
            };

            button.onclick = (e) => {
                e.stopPropagation();
                toggleDrawer();
            };

            menu.querySelectorAll('a').forEach((link) => {
                link.onclick = () => toggleDrawer(false);
            });

            document.addEventListener('click', (e) => {
                if (menu.classList.contains('is-open') && !menu.contains(e.target) && !button.contains(e.target)) {
                    toggleDrawer(false);
                }
            });

            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && menu.classList.contains('is-open')) {
                    toggleDrawer(false);
                }
            });
        }

        // 5. Update Wishlist & Cart Counters Everywhere
        if (window.BookstoreApi) {
            window.BookstoreApi.getWishlist()
                .then((books) => document.querySelectorAll('[data-wishlist-count]').forEach((badge) => { badge.textContent = books.length; }))
                .catch(() => {});
        }
        Store.updateCartCount();

        initTheme();
        initCustomerNavigation();
    }

    function ensureMobileMenu(menu) {
        if (!menu.querySelector('a[href*="wishlist"]')) {
            const link = document.createElement('a');
            link.href = resolvePageUrl('wishlist');
            link.className = 'mobile-drawer-link flex items-center justify-between px-4 py-3 text-gray-700 hover:text-blue-600 font-medium';
            link.innerHTML = '<span class="flex items-center gap-2"><i class="far fa-heart text-emerald-400" aria-hidden="true"></i> Wishlist</span><span class="badge-pill" data-wishlist-count>0</span>';
            menu.append(link);
        }
        if (!menu.querySelector('a[href*="cart"]')) {
            const link = document.createElement('a');
            link.href = resolvePageUrl('cart');
            link.className = 'mobile-drawer-link flex items-center justify-between px-4 py-3 text-gray-700 hover:text-blue-600 font-medium';
            link.innerHTML = '<span class="flex items-center gap-2"><i class="fas fa-shopping-cart text-emerald-400" aria-hidden="true"></i> Shopping Bag</span><span class="badge-pill" data-cart-count>0</span>';
            menu.append(link);
        }
        const authLinks = Array.from(menu.querySelectorAll('[data-mobile-auth], [data-auth-link], a[href*="login"], a[href*="account"]'));
        if (authLinks.length > 0) {
            authLinks[0].dataset.mobileAuth = '';
            // Remove any accidental duplicate auth links in the drawer
            for (let i = 1; i < authLinks.length; i++) {
                authLinks[i].remove();
            }
        } else {
            const link = document.createElement('a');
            link.href = resolvePageUrl('login');
            link.dataset.mobileAuth = '';
            link.className = 'mobile-drawer-link flex items-center gap-2 px-4 py-3 text-gray-700 hover:text-blue-600 font-medium';
            link.innerHTML = '<i class="fas fa-user text-emerald-400" aria-hidden="true"></i> Login / Account';
            menu.append(link);
        }
    }

    function initCustomerNavigation() {
        if (!window.BookstoreApi) return;
        const accountLink = document.querySelector('nav.sticky [data-auth-link], nav.sticky a[href*="login"], nav.sticky a[href*="account"]');
        const mobileAuthLink = document.querySelector('[data-mobile-auth]');
        if (!accountLink && !mobileAuthLink) return;
        window.BookstoreApi.request('/api/auth/session').then((result) => {
            if (!result.authenticated) return;
            const accountUrl = resolvePageUrl('account');
            if (accountLink) {
                accountLink.href = accountUrl;
                accountLink.innerHTML = '<i class="fas fa-user-check mr-2" aria-hidden="true"></i>Account';
                accountLink.setAttribute('aria-label', 'Open your account');
            }
            if (mobileAuthLink) {
                mobileAuthLink.href = accountUrl;
                mobileAuthLink.innerHTML = `<i class="fas fa-user-check text-emerald-400" aria-hidden="true"></i> My Account (${Store.escapeHTML(result.user?.name || 'Reader')})`;
            }
        }).catch(() => {});
    }

    function initTheme() {
        const storedTheme = localStorage.getItem(THEME_KEY);
        const initialTheme = storedTheme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
        applyTheme(initialTheme, false);

        const actions = document.querySelector('nav.sticky .nav-actions, nav.sticky .space-x-4, nav.sticky .space-x-3');
        if (!actions || actions.querySelector('[data-theme-toggle]')) return;
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'nav-icon-link theme-toggle';
        toggle.dataset.themeToggle = '';
        toggle.setAttribute('aria-label', 'Toggle dark and light mode');
        toggle.addEventListener('click', () => {
            const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
            applyTheme(nextTheme, true);
            updateThemeButton(toggle, nextTheme);
        });
        const burger = actions.querySelector('#mobileMenuButton');
        if (burger) actions.insertBefore(toggle, burger);
        else actions.append(toggle);
        updateThemeButton(toggle, initialTheme);
    }

    function applyTheme(theme, persist) {
        const resolvedTheme = theme === 'dark' ? 'dark' : 'light';
        document.documentElement.dataset.theme = resolvedTheme;
        if (persist) localStorage.setItem(THEME_KEY, resolvedTheme);
    }

    function updateThemeButton(button, theme) {
        const isDark = theme === 'dark';
        button.innerHTML = `<i class="fas fa-${isDark ? 'sun' : 'moon'}" aria-hidden="true"></i>`;
        button.setAttribute('aria-label', `Switch to ${isDark ? 'light' : 'dark'} theme`);
        button.setAttribute('aria-pressed', String(isDark));
        button.title = `Switch to ${isDark ? 'light' : 'dark'} theme`;
    }

    window.Store = {
        getCart,
        saveCart,
        addToCart,
        updateQuantity,
        removeFromCart,
        updateCartCount,
        formatCurrency,
        bookCoverImage,
        escapeHTML,
        notify,
        readJSON
    };

    document.addEventListener('DOMContentLoaded', () => {
        initNavigation();
        updateCartCount();
    });
    window.addEventListener('storage', updateCartCount);
})();