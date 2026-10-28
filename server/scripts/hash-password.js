import { stdin, stdout } from 'node:process';
import { hashPassword } from '../auth.js';

function readHiddenPassword() {
    return new Promise((resolve, reject) => {
        if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
            reject(new Error('Run this command in an interactive terminal so the password can be hidden.'));
            return;
        }

        let password = '';
        stdout.write('Admin password (minimum 12 characters, input hidden): ');
        stdin.setRawMode(true);
        stdin.resume();
        const finish = (error) => {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener('data', onData);
            stdout.write('\n');
            if (error) reject(error);
            else resolve(password);
        };
        const onData = (chunk) => {
            const input = chunk.toString('utf8');
            if (input === '\u0003') return finish(new Error('Password entry cancelled.'));
            if (input === '\r' || input === '\n') return finish();
            if (input === '\u007f' || input === '\b') {
                password = password.slice(0, -1);
                return;
            }
            if (!/[\u0000-\u001f]/.test(input)) password += input;
        };
        stdin.on('data', onData);
    });
}

try {
    const password = await readHiddenPassword();
    if (password.length < 12) throw new Error('Use an admin password with at least 12 characters.');
    console.log(`ADMIN_PASSWORD_HASH=${hashPassword(password)}`);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}