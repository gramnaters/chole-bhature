const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
require('dotenv').config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const ownerId = parseInt(process.env.OWNER_CHAT_ID);

if (!token || !ownerId) {
    console.warn('[TeleBot] Missing TELEGRAM_BOT_TOKEN or OWNER_CHAT_ID in .env. Bot disabled.');
    module.exports = { init: () => {} };
    return;
}

// Ensure authorized_users.json exists
const authFilePath = path.join(__dirname, 'authorized_users.json');
if (!fs.existsSync(authFilePath)) {
    fs.writeFileSync(authFilePath, JSON.stringify([]));
}

let bot;
try {
    bot = new TelegramBot(token, { polling: true });
} catch (e) {
    console.warn('[TeleBot] Failed to start bot:', e.message);
    module.exports = { init: () => {} };
    return;
}

console.log('[TeleBot] Initialized and polling for commands.');

// Persist CF Tunnel across restarts
const cfFile = path.join(__dirname, 'cf_tunnel.json');
const cfErrLog = path.join(__dirname, 'cf_err.log');

global.cfUrl = null;
global.cfPid = null;

if (fs.existsSync(cfFile)) {
    try {
        const data = JSON.parse(fs.readFileSync(cfFile, 'utf8'));
        if (data.pid) {
            try {
                process.kill(data.pid, 0); // Check if process is still running
                global.cfPid = data.pid;
                global.cfUrl = data.url;
                console.log('[TeleBot] Restored active CF Tunnel:', data.url);
            } catch (e) {
                // Process is dead
                fs.unlinkSync(cfFile);
            }
        }
    } catch (e) {}
}

// Helpers
function getAuthorizedUsers() {
    try { return JSON.parse(fs.readFileSync(authFilePath, 'utf8')); } 
    catch (e) { return []; }
}
function saveAuthorizedUsers(users) {
    fs.writeFileSync(authFilePath, JSON.stringify(users, null, 2));
}

const tokensFilePath = path.join(__dirname, 'access_tokens.json');
if (!fs.existsSync(tokensFilePath)) {
    fs.writeFileSync(tokensFilePath, JSON.stringify([]));
}
function getTokens() {
    try { return JSON.parse(fs.readFileSync(tokensFilePath, 'utf8')); } 
    catch (e) { return []; }
}
function saveTokens(tokens) {
    fs.writeFileSync(tokensFilePath, JSON.stringify(tokens, null, 2));
}

const reqFilePath = path.join(__dirname, 'token_requests.json');
if (!fs.existsSync(reqFilePath)) {
    fs.writeFileSync(reqFilePath, JSON.stringify([]));
}
function getTokenRequests() {
    try { return JSON.parse(fs.readFileSync(reqFilePath, 'utf8')); } 
    catch (e) { return []; }
}
function saveTokenRequests(reqs) {
    fs.writeFileSync(reqFilePath, JSON.stringify(reqs, null, 2));
}

function isAuthorized(chatId) {
    if (chatId === ownerId) return true;
    const users = getAuthorizedUsers();
    return users.includes(chatId);
}

// Menus
const MAIN_MENU = {
    reply_markup: {
        inline_keyboard: [
            [{ text: '≡ƒÜÇ Deploy & Restart', callback_data: 'cmd_deploy' }],
            [{ text: '≡ƒîÉ Manage CF Tunnel', callback_data: 'cmd_manage_cf' }, { text: '≡ƒöï Hardware Status', callback_data: 'cmd_status' }],
            [{ text: '≡ƒæÑ Manage Sudo Users', callback_data: 'cmd_manage' }],
            [{ text: '≡ƒöæ Manage Access Tokens', callback_data: 'cmd_manage_tokens' }]
        ]
    }
};

const MANAGE_MENU = {
    reply_markup: {
        inline_keyboard: [
            [{ text: 'Γ₧ò Add Sudo User', callback_data: 'cmd_adduser' }, { text: 'Γ₧û Remove User', callback_data: 'cmd_removeuser' }],
            [{ text: '≡ƒôï List Sudo Users', callback_data: 'cmd_listusers' }],
            [{ text: '≡ƒöÖ Back to Menu', callback_data: 'cmd_menu' }]
        ]
    }
};

const TOKENS_MENU = {
    reply_markup: {
        inline_keyboard: [
            [{ text: '≡ƒô⌐ Pending Requests', callback_data: 'cmd_pending_reqs' }],
            [{ text: 'Γ₧ò Generate Token', callback_data: 'cmd_addtoken' }, { text: 'Γ₧û Remove Token', callback_data: 'cmd_removetoken' }],
            [{ text: '≡ƒôï List Tokens', callback_data: 'cmd_listtokens' }],
            [{ text: '≡ƒöÖ Back to Menu', callback_data: 'cmd_menu' }]
        ]
    }
};

// Handlers
bot.onText(/\/(start|menu) ?(.*)/, (msg, match) => {
    const chatId = msg.chat.id;
    const payload = match[2];

    if (payload === 'token') {
        bot.sendMessage(chatId, '≡ƒæï **Welcome to Mini-Debrid!**\n\nPlease reply to this message with a brief reason for requesting a Premium Access Token.', {
            parse_mode: 'Markdown',
            reply_markup: { force_reply: true }
        }).then(sentMsg => {
            bot.onReplyToMessage(sentMsg.chat.id, sentMsg.message_id, (reply) => {
                const reason = reply.text.trim();
                if (!reason) return bot.sendMessage(chatId, 'Γ¥î Request cancelled: No reason provided.');
                
                const reqs = getTokenRequests();
                if (reqs.find(r => r.id === chatId)) {
                    return bot.sendMessage(chatId, 'ΓÜá∩╕Å You already have a pending token request. Please wait for the admin to review it.');
                }
                
                reqs.push({
                    id: chatId,
                    username: msg.from.username || msg.from.first_name || 'Unknown',
                    reason: reason,
                    date: new Date().toISOString()
                });
                saveTokenRequests(reqs);
                
                bot.sendMessage(chatId, 'Γ£à **Request Sent!**\nYour request has been forwarded to the admin. You will receive a message here if it is approved.', { parse_mode: 'Markdown' });
                
                if (ownerId) {
                    bot.sendMessage(ownerId, `≡ƒô⌐ **New Token Request**\n\n≡ƒæñ **From:** @${msg.from.username || msg.from.first_name} (ID: \`${chatId}\`)\n≡ƒô¥ **Reason:** "${reason}"\n\nGo to /menu -> Manage Tokens to review.`, { parse_mode: 'Markdown' });
                }
            });
        });
        return;
    }

    if (!isAuthorized(chatId)) {
        bot.sendMessage(chatId, 'Γ¢ö Unauthorized access.');
        return;
    }
    
    sendDetailedMenu(chatId);
});

function sendDetailedMenu(chatId, messageId = null) {
    const uptime = (os.uptime() / 60 / 60).toFixed(1) + 'h';
    const totalMem = (os.totalmem() / 1024 / 1024).toFixed(0);
    const freeMem = (os.freemem() / 1024 / 1024).toFixed(0);
    const usedMem = totalMem - freeMem;
    const reqs = getTokenRequests().length;
    
    let text = `≡ƒÄ¢∩╕Å **Chole Bhature Control Panel**\n`;
    text += `ΓöüΓöüΓöüΓöüΓöüΓöüΓöüΓöüΓöüΓöüΓöüΓöüΓöüΓöüΓöüΓöüΓöüΓöü\n`;
    text += `≡ƒôè **System Statistics**\n`;
    text += `ΓÅ▒∩╕Å **Uptime:** \`${uptime}\`\n`;
    text += `≡ƒºá **RAM:** \`${usedMem}MB / ${totalMem}MB\`\n`;
    text += `≡ƒô¿ **Pending Tokens:** \`${reqs} Requests\`\n\n`;
    text += `≡ƒîÉ **Cloudflare Tunnel Status**\n`;
    text += `${global.cfUrl ? `Γ£à Online: \n\`${global.cfUrl}\`` : 'Γ¥î Offline'}\n`;
    text += `ΓöüΓöüΓöüΓöüΓöüΓöüΓöüΓöüΓöüΓöüΓöüΓöüΓöüΓöüΓöüΓöüΓöüΓöü\n`;
    text += `Select a command below:`;

    const opts = Object.assign({ parse_mode: 'Markdown' }, MAIN_MENU);
    
    if (messageId) {
        opts.chat_id = chatId;
        opts.message_id = messageId;
        bot.editMessageText(text, opts).catch(()=>{});
    } else {
        bot.sendMessage(chatId, text, opts);
    }
}

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (!isAuthorized(chatId)) {
        bot.answerCallbackQuery(query.id, { text: 'Unauthorized', show_alert: true });
        return;
    }

    if (data === 'cmd_menu') {
        bot.answerCallbackQuery(query.id);
        sendDetailedMenu(chatId, query.message.message_id);
    }
    else if (data === 'cmd_manage_cf') {
        bot.answerCallbackQuery(query.id);
        let text = `≡ƒîÉ **Cloudflare Tunnel Management**\n\n`;
        let kb = [];
        if (global.cfUrl) {
            text += `Γ£à **Tunnel is ACTIVE**\n≡ƒöù \`${global.cfUrl}/configure\`\n\n_Share this link with your users!_`;
            kb.push([{ text: '≡ƒ¢æ Stop Tunnel', callback_data: 'cmd_stop_cf_tunnel' }]);
        } else {
            text += `Γ¥î **Tunnel is OFFLINE**\n\nStart the tunnel to generate a public URL.`;
            kb.push([{ text: '≡ƒîÉ Start CF Tunnel', callback_data: 'cmd_cf_tunnel' }]);
        }
        kb.push([{ text: '≡ƒöÖ Back to Menu', callback_data: 'cmd_menu' }]);
        
        bot.editMessageText(text, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: kb }
        }).catch(()=>{});
    }
    else if (data === 'cmd_cf_tunnel') {
        if (global.cfPid) {
            return bot.answerCallbackQuery(query.id, { text: 'ΓÜá∩╕Å Tunnel is already running!', show_alert: true });
        }
        bot.answerCallbackQuery(query.id);
        
        bot.editMessageText('≡ƒîÉ Starting Cloudflare Tunnel (Detached mode)... Please wait.', {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown'
        }).catch(()=>{});

        if (fs.existsSync(cfErrLog)) fs.writeFileSync(cfErrLog, ''); // Clear old log

        const { spawn } = require('child_process');
        const out = fs.openSync(path.join(__dirname, 'cf_out.log'), 'a');
        const err = fs.openSync(cfErrLog, 'a');
        
        const cfProc = spawn('cloudflared', ['tunnel', '--url', 'http://localhost:7000'], {
            detached: true,
            stdio: ['ignore', out, err]
        });
        
        cfProc.unref(); // Detach completely from Node.js
        global.cfPid = cfProc.pid;
        
        let attempts = 0;
        const interval = setInterval(() => {
            attempts++;
            if (attempts > 30) {
                clearInterval(interval);
                bot.sendMessage(chatId, 'ΓÜá∩╕Å Cloudflare Tunnel started, but taking too long to generate URL.');
                return;
            }
            if (fs.existsSync(cfErrLog)) {
                const logData = fs.readFileSync(cfErrLog, 'utf8');
                const match = logData.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
                if (match && !global.cfUrl) {
                    global.cfUrl = match[0];
                    fs.writeFileSync(cfFile, JSON.stringify({ pid: global.cfPid, url: global.cfUrl }));
                    
                    let text = `≡ƒîÉ **Cloudflare Tunnel Management**\n\nΓ£à **Tunnel is ACTIVE**\n≡ƒöù \`${global.cfUrl}/configure\`\n\n_Share this link with your users!_`;
                    bot.editMessageText(text, {
                        chat_id: chatId,
                        message_id: query.message.message_id,
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '≡ƒ¢æ Stop Tunnel', callback_data: 'cmd_stop_cf_tunnel' }], [{ text: '≡ƒöÖ Back to Menu', callback_data: 'cmd_menu' }]] }
                    }).catch(()=>{});
                    clearInterval(interval);
                }
            }
        }, 500);
    }
    else if (data === 'cmd_stop_cf_tunnel') {
        bot.answerCallbackQuery(query.id, { text: 'Stopping tunnel...' });
        if (global.cfPid) {
            try { process.kill(global.cfPid, 'SIGTERM'); } catch(e) {}
            setTimeout(() => {
                try { process.kill(global.cfPid, 'SIGKILL'); } catch(e) {}
            }, 500);
            
            global.cfPid = null;
            global.cfUrl = null;
            if (fs.existsSync(cfFile)) fs.unlinkSync(cfFile);
            
            let text = `≡ƒîÉ **Cloudflare Tunnel Management**\n\nΓ¥î **Tunnel is OFFLINE**\n\nStart the tunnel to generate a public URL.`;
            bot.editMessageText(text, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '≡ƒîÉ Start CF Tunnel', callback_data: 'cmd_cf_tunnel' }], [{ text: '≡ƒöÖ Back to Menu', callback_data: 'cmd_menu' }]] }
            }).catch(()=>{});
        } else {
            bot.answerCallbackQuery(query.id, { text: 'ΓÜá∩╕Å Tunnel is not running.', show_alert: true });
        }
    }
    else if (data === 'cmd_deploy') {
        bot.answerCallbackQuery(query.id, { text: 'Deploying...' });
        bot.editMessageText('≡ƒÜÇ Pulling from GitHub and installing dependencies...', {
            chat_id: chatId,
            message_id: query.message.message_id
        }).catch(()=>{});
        
        exec('git pull origin main && npm install', (error, stdout, stderr) => {
            if (error) {
                bot.editMessageText(`Γ¥î **Deploy Failed:**\n\`\`\`\n${stderr || error.message}\n\`\`\``, { 
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '≡ƒöÖ Back to Menu', callback_data: 'cmd_menu' }]] }
                }).catch(()=>{});
            } else {
                bot.editMessageText(`Γ£à **Deploy Successful:**\n\`\`\`\n${stdout.substring(0, 500)}\n\`\`\`\n\n≡ƒöä Restarting server in 2 seconds...`, { 
                    chat_id: chatId,
                    message_id: query.message.message_id,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '≡ƒöÖ Back to Menu', callback_data: 'cmd_menu' }]] }
                }).catch(()=>{});
                setTimeout(() => {
                    process.exit(0); // Assuming PM2 or loop script will restart it
                }, 2000);
            }
        });
    }
    else if (data === 'cmd_status') {
        bot.answerCallbackQuery(query.id, { text: 'Fetching status...' });
        
        // Basic Node.js OS stats
        const totalMem = (os.totalmem() / 1024 / 1024).toFixed(0);
        const freeMem = (os.freemem() / 1024 / 1024).toFixed(0);
        const usedMem = totalMem - freeMem;
        const uptime = (os.uptime() / 60 / 60).toFixed(2);
        const load = os.loadavg()[0].toFixed(2);
        
        let replyMsg = `≡ƒôè **Server Status**\n\n`;
        replyMsg += `ΓÅ▒∩╕Å **Uptime:** ${uptime} Hours\n`;
        replyMsg += `≡ƒºá **RAM:** ${usedMem} MB / ${totalMem} MB\n`;
        replyMsg += `ΓÜÖ∩╕Å **CPU Load:** ${load}\n\n`;

        // Try Termux API for battery (fails gracefully on Windows)
        exec('termux-battery-status', (error, stdout) => {
            if (!error && stdout) {
                try {
                    const bat = JSON.parse(stdout);
                    replyMsg += `≡ƒöï **Battery:** ${bat.percentage}%\n`;
                    replyMsg += `≡ƒîí∩╕Å **Temperature:** ${bat.temperature}┬░C\n`;
                    replyMsg += `≡ƒöî **Status:** ${bat.status}\n`;
                } catch (e) {}
            }
            bot.editMessageText(replyMsg, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '≡ƒöÖ Back to Menu', callback_data: 'cmd_menu' }]]
                }
            }).catch(()=>{});
        });
    }
    else if (data === 'cmd_manage') {
        if (chatId !== ownerId) {
            bot.answerCallbackQuery(query.id, { text: 'Only the Owner can manage users.', show_alert: true });
            return;
        }
        bot.editMessageText('≡ƒæÑ **Manage Sudo Users**\nSelect an action:', Object.assign({
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown'
        }, MANAGE_MENU));
        bot.answerCallbackQuery(query.id);
    }
    else if (data === 'cmd_listusers') {
        if (chatId !== ownerId) return;
        const users = getAuthorizedUsers();
        bot.answerCallbackQuery(query.id);
        if (users.length === 0) {
            bot.editMessageText('No sudo users authorized.', {
                chat_id: chatId,
                message_id: query.message.message_id,
                reply_markup: { inline_keyboard: [[{ text: '≡ƒöÖ Back to Menu', callback_data: 'cmd_manage' }]] }
            }).catch(()=>{});
        } else {
            bot.editMessageText(`≡ƒôï **Sudo Users:**\n\n${users.map(u => `\`${u}\``).join('\n')}`, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '≡ƒöÖ Back to Menu', callback_data: 'cmd_manage' }]] }
            }).catch(()=>{});
        }
    }
    else if (data === 'cmd_adduser') {
        if (chatId !== ownerId) return;
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, 'Reply to this message with the Telegram Chat ID you want to ADD as Sudo (or type /menu to cancel):', {
            reply_markup: { force_reply: true }
        }).then(sentMsg => {
            bot.onReplyToMessage(sentMsg.chat.id, sentMsg.message_id, (reply) => {
                if (reply.text === '/menu') return;
                const newId = parseInt(reply.text.trim());
                if (isNaN(newId)) return bot.sendMessage(chatId, 'Γ¥î Invalid ID. Must be a number.');
                const users = getAuthorizedUsers();
                if (!users.includes(newId)) {
                    users.push(newId);
                    saveAuthorizedUsers(users);
                    bot.sendMessage(chatId, `Γ£à Added \`${newId}\` to Sudo users.\n\nSend /menu to return.`, { parse_mode: 'Markdown' });
                } else {
                    bot.sendMessage(chatId, 'ΓÜá∩╕Å User already exists.\n\nSend /menu to return.');
                }
            });
        });
    }
    else if (data === 'cmd_removeuser') {
        if (chatId !== ownerId) return;
        bot.answerCallbackQuery(query.id);
        bot.sendMessage(chatId, 'Reply to this message with the Telegram Chat ID you want to REMOVE from Sudo (or type /menu to cancel):', {
            reply_markup: { force_reply: true }
        }).then(sentMsg => {
            bot.onReplyToMessage(sentMsg.chat.id, sentMsg.message_id, (reply) => {
                if (reply.text === '/menu') return;
                const delId = parseInt(reply.text.trim());
                if (isNaN(delId)) return bot.sendMessage(chatId, 'Γ¥î Invalid ID.');
                let users = getAuthorizedUsers();
                if (users.includes(delId)) {
                    users = users.filter(id => id !== delId);
                    saveAuthorizedUsers(users);
                    bot.sendMessage(chatId, `Γ£à Removed Sudo user \`${delId}\`.\n\nSend /menu to return.`, { parse_mode: 'Markdown' });
                } else {
                    bot.sendMessage(chatId, 'ΓÜá∩╕Å User not found.\n\nSend /menu to return.');
                }
            });
        });
    }
    else if (data === 'cmd_manage_tokens') {
        bot.editMessageText('≡ƒöæ **Manage Mini-Debrid Access Tokens**\nSelect an action:', Object.assign({
            chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown'
        }, TOKENS_MENU));
        bot.answerCallbackQuery(query.id);
    }
    else if (data === 'cmd_listtokens') {
        const tokens = getTokens();
        bot.answerCallbackQuery(query.id);
        if (tokens.length === 0) {
            bot.editMessageText('No tokens exist.', {
                chat_id: chatId,
                message_id: query.message.message_id,
                reply_markup: { inline_keyboard: [[{ text: '≡ƒöÖ Back to Menu', callback_data: 'cmd_manage_tokens' }]] }
            }).catch(()=>{});
        } else {
            const tokenList = tokens.map(t => {
                if (typeof t === 'string') return `\`${t}\` (Legacy)`;
                return `≡ƒæñ **${t.username}** (\`${t.userId}\`)\n≡ƒöæ \`${t.token}\``;
            }).join('\n\n');
            bot.editMessageText(`≡ƒôï **Premium Access Tokens:**\n\n${tokenList}`, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '≡ƒöÖ Back to Menu', callback_data: 'cmd_manage_tokens' }]] }
            }).catch(()=>{});
        }
    }
    else if (data === 'cmd_pending_reqs') {
        const reqs = getTokenRequests();
        bot.answerCallbackQuery(query.id);
        if (reqs.length === 0) {
            return bot.sendMessage(chatId, 'No pending token requests.', { reply_markup: { inline_keyboard: [[{ text: '≡ƒöÖ Back', callback_data: 'cmd_manage_tokens' }]] } });
        }
        
        reqs.forEach((r, index) => {
            const kb = [[
                { text: 'Γ£à Approve', callback_data: `cmd_approve_${r.id}` },
                { text: 'Γ¥î Reject', callback_data: `cmd_reject_${r.id}` }
            ]];
            setTimeout(() => {
                bot.sendMessage(chatId, `≡ƒæñ **Request from @${r.username}**\n≡ƒåö \`${r.id}\`\n≡ƒô¥ "${r.reason}"\n≡ƒòÆ ${new Date(r.date).toLocaleString()}`, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: kb }
                });
            }, index * 200);
        });
    }
    else if (data.startsWith('cmd_approve_')) {
        const targetId = parseInt(data.replace('cmd_approve_', ''));
        bot.answerCallbackQuery(query.id);
        
        let reqs = getTokenRequests();
        const reqIndex = reqs.findIndex(r => r.id === targetId);
        if (reqIndex === -1) return bot.sendMessage(chatId, 'ΓÜá∩╕Å Request no longer exists.');
        
        // Generate Token
        const crypto = require('crypto');
        const newToken = 'chole-bhature-' + crypto.randomBytes(4).toString('hex');
        
        const tokens = getTokens();
        tokens.push({
            token: newToken,
            userId: targetId,
            username: reqs[reqIndex].username || 'Unknown',
            date: new Date().toISOString()
        });
        saveTokens(tokens);
        
        // Remove Request
        reqs.splice(reqIndex, 1);
        saveTokenRequests(reqs);
        
        // Notify Owner
        bot.editMessageText(`Γ£à **Approved** @${targetId}\nToken: \`${newToken}\``, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown'
        });
        
        // Notify User
        bot.sendMessage(targetId, `≡ƒÄë **Your Token Request was Approved!**\n\nHere is your Mini-Debrid Access Token:\n\`${newToken}\`\n\nPaste this in the addon configuration page to unlock HTTP Engine streaming!`, { parse_mode: 'Markdown' }).catch(err => {
            bot.sendMessage(chatId, `ΓÜá∩╕Å Could not message user ${targetId}. They might have blocked the bot.`);
        });
    }
    else if (data.startsWith('cmd_reject_')) {
        const targetId = parseInt(data.replace('cmd_reject_', ''));
        bot.answerCallbackQuery(query.id);
        
        let reqs = getTokenRequests();
        reqs = reqs.filter(r => r.id !== targetId);
        saveTokenRequests(reqs);
        
        bot.editMessageText(`Γ¥î **Rejected** @${targetId}`, {
            chat_id: chatId,
            message_id: query.message.message_id
        });
        
        bot.sendMessage(targetId, `Γ¥î **Your Token Request was Rejected.**`, { parse_mode: 'Markdown' }).catch(()=>{});
    }
    else if (data === 'cmd_addtoken') {
        const crypto = require('crypto');
        const newToken = 'chole-bhature-' + crypto.randomBytes(4).toString('hex'); // e.g., 'chole-bhature-a1b2c3d4'
        bot.answerCallbackQuery(query.id);
        
        const tokens = getTokens();
        tokens.push({
            token: newToken,
            userId: 'Manual',
            username: 'Manual Generation',
            date: new Date().toISOString()
        });
        saveTokens(tokens);
        
        bot.sendMessage(chatId, `Γ£à **Generated New Token:**\n\`${newToken}\`\n\nShare this token with the user.`, { parse_mode: 'Markdown' });
    }
    else if (data === 'cmd_removetoken') {
        const tokens = getTokens();
        bot.answerCallbackQuery(query.id);
        if (tokens.length === 0) {
            return bot.editMessageText('No tokens exist to remove.', {
                chat_id: chatId,
                message_id: query.message.message_id,
                reply_markup: { inline_keyboard: [[{ text: '≡ƒöÖ Back to Menu', callback_data: 'cmd_manage_tokens' }]] }
            }).catch(()=>{});
        }
        
        const kb = tokens.map((t, index) => {
            const label = typeof t === 'string' ? `Legacy: ${t.substring(0, 15)}...` : `${t.username} (${t.userId})`;
            return [{ text: `Γ¥î ${label}`, callback_data: `cmd_deltoken_${index}` }];
        });
        kb.push([{ text: '≡ƒöÖ Back to Menu', callback_data: 'cmd_manage_tokens' }]);

        bot.editMessageText('Select a token to REMOVE:', {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: { inline_keyboard: kb }
        }).catch(()=>{});
    }
    else if (data.startsWith('cmd_deltoken_')) {
        const idx = parseInt(data.replace('cmd_deltoken_', ''));
        bot.answerCallbackQuery(query.id);
        let tokens = getTokens();
        if (idx >= 0 && idx < tokens.length) {
            const deleted = tokens.splice(idx, 1)[0];
            const tokenStr = typeof deleted === 'string' ? deleted : deleted.token;
            saveTokens(tokens);
            bot.editMessageText(`Γ£à Removed Token:\n\`${tokenStr}\``, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '≡ƒöÖ Back to Menu', callback_data: 'cmd_manage_tokens' }]] }
            }).catch(()=>{});
        }
    }
});

module.exports = {
    init: () => {
        // Expose a way for index.js to send messages (e.g. startup Cloudflare URL)
    },
    sendMessageToOwner: (msg) => {
        if (bot && ownerId) {
            bot.sendMessage(ownerId, msg, { parse_mode: 'Markdown' }).catch(() => {});
        }
    }
};
