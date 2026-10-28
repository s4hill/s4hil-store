(function () {
    function escape(value) {
        return Store.escapeHTML(value);
    }

    function categoryLabel(book) {
        return escape(book.category_name || String(book.category || '').replaceAll('-', ' '));
    }

    function renderCard(book, saved) {
        const pagePrefix = window.location.pathname.includes('/pages/') ? '' : 'pages/';
        const detailUrl = `${pagePrefix}book.html?id=${encodeURIComponent(book.id)}`;
        const coverUrl = BookstoreApi.coverSource(book);
        const unavailable = book.stock_quantity === 0;
        const availability = book.stock_quantity === null || book.stock_quantity === undefined
            ? ''
            : `<span class="book-stock ${unavailable ? 'is-out' : ''}">${unavailable ? 'Out of stock' : `${book.stock_quantity} in stock`}</span>`;
        const originalPrice = book.original_price === null || book.original_price === undefined
            ? ''
            : `<del>${Store.formatCurrency(book.original_price)}</del>`;

        return `<article class="book-card">
            <div class="book-cover-shell">
                <a class="book-cover-link" href="${detailUrl}" aria-label="View ${escape(book.title)} details"><div class="book-cover-frame" data-title="${escape(book.title)}" data-category="${escape(book.category)}"><img data-cover-id="${book.id}" src="${escape(coverUrl)}" alt="Cover of ${escape(book.title)}" loading="lazy" width="360" height="480"></div></a>
                <button class="wishlist-toggle ${saved ? 'is-saved' : ''}" data-wishlist-id="${book.id}" type="button" aria-pressed="${saved}" aria-label="${saved ? 'Remove' : 'Save'} ${escape(book.title)} ${saved ? 'from' : 'to'} wishlist"><i class="${saved ? 'fas' : 'far'} fa-heart" aria-hidden="true"></i></button>
            </div>
            <div class="book-card-copy">
                <p class="book-card-category">${categoryLabel(book)}</p>
                <h2><a href="${detailUrl}">${escape(book.title)}</a></h2>
                <p class="book-card-author">by ${escape(book.author)}</p>
                ${availability}
                <div class="book-card-buy"><p>${originalPrice}<strong>${Store.formatCurrency(book.price)}</strong></p><div class="book-card-actions"><a href="${detailUrl}" class="book-detail-link">Details</a><button class="book-add-button" data-add-id="${book.id}" type="button" ${unavailable ? 'disabled' : ''} aria-label="Add ${escape(book.title)} to bag"><i class="fas fa-plus" aria-hidden="true"></i><span>Add</span></button></div></div>
            </div>
        </article>`;
    }

    async function render(container, books) {
        if (!books.length) {
            container.innerHTML = '<div class="store-empty"><h2>No books match these filters.</h2><p>Try a different search or category.</p></div>';
            return;
        }
        let savedIds = new Set();
        try {
            savedIds = new Set((await BookstoreApi.getWishlist()).map((book) => book.id));
        } catch {
            Store.notify('Wishlist could not be loaded. You can still browse the collection.');
        }

        container.innerHTML = books.map((book) => renderCard(book, savedIds.has(book.id))).join('');
        BookstoreApi.bindCoverFallbacks(container, books);
        const booksById = new Map(books.map((book) => [book.id, book]));

        container.querySelectorAll('[data-add-id]').forEach((button) => {
            button.addEventListener('click', () => Store.addToCart(booksById.get(Number(button.dataset.addId))));
        });
        container.querySelectorAll('[data-wishlist-id]').forEach((button) => {
            button.addEventListener('click', async () => {
                const book = booksById.get(Number(button.dataset.wishlistId));
                const wasSaved = button.getAttribute('aria-pressed') === 'true';
                try {
                    const isSaved = await BookstoreApi.toggleWishlist(book, wasSaved);
                    button.setAttribute('aria-pressed', String(isSaved));
                    button.classList.toggle('is-saved', isSaved);
                    button.setAttribute('aria-label', `${isSaved ? 'Remove' : 'Save'} ${book.title} ${isSaved ? 'from' : 'to'} wishlist`);
                    button.querySelector('i').className = `${isSaved ? 'fas' : 'far'} fa-heart`;
                    const wishlist = await BookstoreApi.getWishlist();
                    document.querySelectorAll('[data-wishlist-count]').forEach((badge) => { badge.textContent = wishlist.length; });
                    Store.notify(isSaved ? `${book.title} saved to wishlist` : `${book.title} removed from wishlist`);
                } catch (error) {
                    Store.notify(error.message);
                }
            });
        });
    }

    window.CatalogUI = { render };
})();
