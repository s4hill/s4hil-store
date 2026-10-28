import 'dotenv/config';
import { createDatabase } from './database.js';

const database = createDatabase();
const bookCount = database.prepare('SELECT COUNT(*) AS count FROM books').get().count;
const categoryCount = database.prepare('SELECT COUNT(*) AS count FROM categories').get().count;
console.log(`SQLite ready: ${bookCount} books across ${categoryCount} categories.`);
database.close();