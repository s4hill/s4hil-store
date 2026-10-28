document.addEventListener('DOMContentLoaded', async () => {
    const categoryFilter = document.getElementById('categoryFilter');
    const authorFilter = document.getElementById('authorFilter');
    const priceFilter = document.getElementById('priceFilter');
    const sortBy = document.getElementById('sortBy');
    const searchInput = document.getElementById('bookSearch');
    const booksGrid = document.getElementById('booksGrid');
    const pagination = document.getElementById('pagination');
    const resultSummary = document.getElementById('resultSummary');
    const limit = 8;
    let page = Math.max(1, Number(new URLSearchParams(location.search).get('page')) || 1);
    let searchTimer;

    function updateUrl() {
        const params = new URLSearchParams();
        if (categoryFilter.value !== 'all') params.set('category', categoryFilter.value);
        if (searchInput.value.trim()) params.set('search', searchInput.value.trim());
        if (authorFilter.value.trim()) params.set('author', authorFilter.value.trim());
        if (priceFilter.value !== 'all') {
            if (priceFilter.value.endsWith('+')) {
                const minPrice = priceFilter.value.slice(0, -1);
                if (minPrice) params.set('minPrice', minPrice);
            } else {
                const [minPrice, maxPrice] = priceFilter.value.split('-');
                if (minPrice) params.set('minPrice', minPrice);
                if (maxPrice) params.set('maxPrice', maxPrice);
            }
        }
        if (sortBy.value !== 'featured') params.set('sort', sortBy.value);
        if (page > 1) params.set('page', page);
        history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
    }

    function renderPagination(pageCount) {
        if (pageCount <= 1) {
            pagination.innerHTML = '';
            return;
        }
        const pages = Array.from({ length: pageCount }, (_, index) => {
            const number = index + 1;
            return `<button type="button" class="catalog-page-button ${number === page ? 'is-current' : ''}" data-page="${number}" aria-current="${number === page ? 'page' : 'false'}">${number}</button>`;
        }).join('');
        pagination.innerHTML = `<button type="button" class="catalog-page-button" data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>Previous</button>${pages}<button type="button" class="catalog-page-button" data-page="${page + 1}" ${page === pageCount ? 'disabled' : ''}>Next</button>`;
        pagination.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', () => {
            page = Number(button.dataset.page);
            loadBooks();
            document.querySelector('main').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }));
    }

    async function loadBooks() {
        const params = new URLSearchParams({ page, limit, sort: sortBy.value });
        if (categoryFilter.value !== 'all') params.set('category', categoryFilter.value);
        if (searchInput.value.trim()) params.set('search', searchInput.value.trim());
        if (authorFilter.value.trim()) params.set('author', authorFilter.value.trim());
        if (priceFilter.value !== 'all') {
            if (priceFilter.value.endsWith('+')) {
                const minPrice = priceFilter.value.slice(0, -1);
                if (minPrice) params.set('minPrice', minPrice);
            } else {
                const [minPrice, maxPrice] = priceFilter.value.split('-');
                if (minPrice) params.set('minPrice', minPrice);
                if (maxPrice) params.set('maxPrice', maxPrice);
            }
        }

        resultSummary.textContent = 'Loading books…';
        booksGrid.setAttribute('aria-busy', 'true');
        try {
            const result = await BookstoreApi.request(`/api/books?${params}`);
            resultSummary.textContent = `${result.total} ${result.total === 1 ? 'book' : 'books'} found`;
            await CatalogUI.render(booksGrid, result.books);
            renderPagination(result.pages);
            updateUrl();
        } catch (error) {
            resultSummary.textContent = 'The catalog could not be loaded.';
            booksGrid.innerHTML = `<div class="catalog-error" role="alert">${Store.escapeHTML(error.message)} <button type="button" id="retryCatalog">Retry</button></div>`;
            document.getElementById('retryCatalog').addEventListener('click', loadBooks);
        } finally {
            booksGrid.setAttribute('aria-busy', 'false');
        }
    }

    try {
        const categories = await BookstoreApi.request('/api/categories');
        categoryFilter.innerHTML = '<option value="all">All categories</option>' + categories.categories.map((category) => `<option value="${Store.escapeHTML(category.slug)}">${Store.escapeHTML(category.name)}</option>`).join('');
        document.getElementById('collectionStats').textContent = 'Find a new favorite across every shelf';
    } catch (error) {
        resultSummary.textContent = `Could not load catalog filters: ${error.message}`;
    }

    const initial = new URLSearchParams(location.search);
    if ([...categoryFilter.options].some((option) => option.value === initial.get('category'))) categoryFilter.value = initial.get('category');
    if (initial.has('search')) searchInput.value = initial.get('search');
    if (initial.has('author')) authorFilter.value = initial.get('author');
    if (initial.has('sort') && [...sortBy.options].some((option) => option.value === initial.get('sort'))) sortBy.value = initial.get('sort');
    if (initial.has('minPrice') && initial.has('maxPrice')) {
        const range = `${initial.get('minPrice')}-${initial.get('maxPrice')}`;
        if ([...priceFilter.options].some((option) => option.value === range)) priceFilter.value = range;
    } else if (initial.has('minPrice') && [...priceFilter.options].some((option) => option.value === `${initial.get('minPrice')}+`)) {
        priceFilter.value = `${initial.get('minPrice')}+`;
    }

    const scheduleSearch = () => {
        clearTimeout(searchTimer);
        page = 1;
        searchTimer = setTimeout(loadBooks, 220);
    };
    searchInput.addEventListener('input', scheduleSearch);
    authorFilter.addEventListener('input', scheduleSearch);
    categoryFilter.addEventListener('change', () => { page = 1; loadBooks(); });
    priceFilter.addEventListener('change', () => { page = 1; loadBooks(); });
    sortBy.addEventListener('change', () => { page = 1; loadBooks(); });
    document.getElementById('resetFilters').addEventListener('click', () => {
        searchInput.value = '';
        authorFilter.value = '';
        categoryFilter.value = 'all';
        priceFilter.value = 'all';
        sortBy.value = 'featured';
        page = 1;
        loadBooks();
    });

    await loadBooks();
});
