(function () {
    async function request(path, options = {}) {
        const response = await fetch(path, {
            credentials: 'same-origin',
            headers: {
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
                ...options.headers
            },
            ...options
        });
        const payload = response.status === 204 ? null : await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status}).`);
        return payload;
    }

    function guestId() {
        let id = localStorage.getItem('s4hil-wishlist-guest');
        if (!id) {
            id = crypto.randomUUID();
            localStorage.setItem('s4hil-wishlist-guest', id);
        }
        return id;
    }

    function coverSource(book) {
        return book.cover_image || Store.bookCoverImage(book);
    }

    function bindCoverFallbacks(container, books) {
        const booksById = new Map(books.map((book) => [String(book.id), book]));
        container.querySelectorAll('img[data-cover-id]').forEach((image) => {
            image.addEventListener('error', () => {
                const book = booksById.get(image.dataset.coverId);
                if (book) image.src = Store.bookCoverImage(book);
            }, { once: true });
        });
    }

    async function getWishlist() {
        const guest = guestId();
        const result = await request(`/api/wishlist?guestId=${encodeURIComponent(guest)}`);
        return result.books;
    }

    async function toggleWishlist(book, currentlySaved) {
        const guest = guestId();
        if (currentlySaved) {
            await request(`/api/wishlist/${book.id}?guestId=${encodeURIComponent(guest)}`, { method: 'DELETE' });
            return false;
        }
        await request('/api/wishlist', {
            method: 'POST',
            body: JSON.stringify({ guestId: guest, bookId: book.id })
        });
        return true;
    }

    window.BookstoreApi = { request, guestId, coverSource, bindCoverFallbacks, getWishlist, toggleWishlist };
})();
