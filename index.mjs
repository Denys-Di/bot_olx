import TelegramBot from 'node-telegram-bot-api';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import express from 'express';
import 'dotenv/config';


// --- КОНФІГУРАЦІЯ ---
const token = process.env.TOKEN;
const isLocal = !process.env.RENDER;
const webhookUrl = process.env.RENDER_EXTERNAL_URL;

// --- ІНІЦІАЛІЗАЦІЯ ---
const bot = new TelegramBot(token, { polling: isLocal });
const app = express();
app.use(express.json());

/*
 * --- КЕРУВАННЯ СТАНОМ ---
 * Зберігає поточні параметри пошуку для кожного користувача.
 * messageId - ID повідомлення з панеллю керування, яке ми редагуємо.
 */
const userStates = {};

// Категорії пошуку. Ключ - назва для кнопки, значення - частина URL для OLX.
const categories = {
    '📱 Телефони': 'elektronika/telefony-i-akcesoria',
    '💻 Ноутбуки': 'elektronika/noutbuki-i-aksesuary',
    '🎧 Навушники': 'elektronika/naushniki',
    '🎮 Ігрові приставки': 'elektronika/pristavki',
};
const categoryKeys = Object.keys(categories);

/**
 * Функція для пошуку оголошень на OLX.
 * @param {object} params - Параметри пошуку: query, city, minPrice, maxPrice, sort, categoryPath.
 * @returns {Promise<Array<object>>} - Масив знайдених оголошень.
 */
async function searchOLX({ query, city, minPrice, maxPrice, sort, categoryPath }) {
    let browser = null;
    try {
        browser = await puppeteer.launch({
            args: chromium.args,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();
        
        const cityPath = city ? `-${city}` : '';
        let searchUrl = `https://www.olx.ua/uk/${categoryPath}/q-${encodeURIComponent(query)}${cityPath}/`;

        const searchParams = new URLSearchParams();
        if (minPrice) searchParams.set('search[filter_float_price:from]', minPrice);
        if (maxPrice) searchParams.set('search[filter_float_price:to]', maxPrice);
        if (sort) searchParams.set('search[order]', sort);
        else searchParams.set('search[order]', 'created_at:desc');
        
        const paramsString = searchParams.toString();
        if (paramsString) {
            searchUrl += `?${paramsString}`;
        }
        
        await page.goto(searchUrl, { waitUntil: 'networkidle0' });
        await page.waitForSelector('div[data-cy="l-card"]', { timeout: 15000 });

        const results = await page.evaluate(() => {
            const items = [];
            const cards = document.querySelectorAll('div[data-cy="l-card"]');
            cards.forEach((el, i) => {
                if (i >= 20) return;
                const title = el.querySelector('h6')?.innerText || '—';
                const price = el.querySelector('[data-testid="ad-price"]')?.innerText || 'Ціна не вказана';
                let link = el.querySelector('a')?.getAttribute('href') || '#';
                if (link.startsWith('/')) {
                    link = `https://www.olx.ua${link}`;
                }
                const image = el.querySelector('img')?.src || null;
                if (title && link !== '#') {
                    items.push({ title, price, link, image });
                }
            });
            return items;
        });

        return results;
    } finally {
        if (browser) await browser.close();
    }
}

/**
 * Відправляє результати пошуку користувачу.
 * @param {number} chatId - ID чату.
 * @param {Array<object>} results - Масив результатів з searchOLX.
 */
async function sendResults(chatId, results) {
    if (results.length > 0) {
        await bot.sendMessage(chatId, `✅ Знайдено ${results.length} оголошень. Відправляю...`);
        for (const item of results) {
            const msgText = `📌 *${item.title}*\n💵 *${item.price}*\n🔗 [Переглянути](${item.link})`;
            try {
                if (item.image) {
                    await bot.sendPhoto(chatId, item.image, { caption: msgText, parse_mode: 'Markdown' });
                } else {
                    await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
                }
            } catch (error) {
                console.error(`Помилка відправки фото: ${error.message}`);
                await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
            }
        }
    } else {
        await bot.sendMessage(chatId, '😕 На жаль, за вашим запитом нічого не знайдено.');
    }
}

// --- ФУНКЦІЇ-ХЕЛПЕРИ ДЛЯ ІНТЕРФЕЙСУ ---

/** Генерує текст повідомлення на основі стану. */
function buildSearchMessage(state) {
    let text = '🔍 *Панель керування пошуком*\n\n';
    text += `*Категорія:* ${state.categoryName || 'не обрано'}\n`;
    text += `*Ключове слово:* ${state.keyword || 'не введено'}\n`;
    text += `*Місто:* ${state.city || 'не введено'}\n`;
    text += `*Ціна:* ${state.minPrice || state.maxPrice ? `${state.minPrice || '0'} - ${state.maxPrice || '∞'}` : 'не вказано'}\n`;
    const sortText = state.sort === 'price:asc' ? 'Від дешевих' : state.sort === 'price:desc' ? 'Від дорогих' : 'за датою (новіші)';
    text += `*Сортування:* ${sortText}\n\n`;
    text += `Натисніть на кнопки, щоб змінити параметри. Коли будете готові, натисніть "Пошук".`;
    return text;
}

/** Генерує інлайн-клавіатуру на основі стану. */
function buildSearchKeyboard(state) {
    const keyboard = [
        [{ text: `Категорія: ${state.categoryName || '❓'}`, callback_data: 'set_category' }],
        [{ text: `Слово: ${state.keyword || '❓'}`, callback_data: 'set_keyword' }, { text: `Місто: ${state.city || '❓'}`, callback_data: 'set_city' }],
        [{ text: `Ціна: ${state.minPrice ? '💰' : '❓'}`, callback_data: 'set_price' }, { text: `Сортування: ${state.sort ? '📈' : '🗓️'}`, callback_data: 'set_sort' }],
        [{ text: '🚀 Пошук', callback_data: 'search' }]
    ];
    return keyboard;
}

/** Оновлює повідомлення з панеллю керування. */
async function updateSearchPanel(chatId) {
    const state = userStates[chatId];
    if (!state || !state.messageId) return;

    const text = buildSearchMessage(state);
    const keyboard = buildSearchKeyboard(state);

    try {
        await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: state.messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
    } catch (e) {
        console.error("Помилка редагування повідомлення:", e.message);
    }
}

// --- ОБРОБНИКИ КОМАНД ТА ПОВІДОМЛЕНЬ ---

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    userStates[chatId] = {
        stage: 'configuring',
        categoryName: null,
        categoryPath: null,
        keyword: null,
        city: null,
        minPrice: null,
        maxPrice: null,
        sort: null,
        messageId: null
    };

    const text = buildSearchMessage(userStates[chatId]);
    const keyboard = buildSearchKeyboard(userStates[chatId]);

    const sentMessage = await bot.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    });
    
    userStates[chatId].messageId = sentMessage.message_id;
});

// Обробник текстових повідомлень (для введення даних)
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Ігноруємо команду /start тут, бо для неї є окремий обробник
    if (text === '/start') return;

    const state = userStates[chatId];
    if (!state || !state.stage.startsWith('awaiting_')) return;

    switch (state.stage) {
        case 'awaiting_keyword':
            state.keyword = text;
            break;
        case 'awaiting_city':
            state.city = text.toLowerCase().trim();
            break;
        case 'awaiting_price':
            const match = text.match(/(\d+)\s*-\s*(\d+)/);
            if (match) {
                state.minPrice = match[1];
                state.maxPrice = match[2];
            } else {
                bot.sendMessage(chatId, "Невірний формат. Введіть, наприклад, `1000-5000`").then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id), 3000));
            }
            break;
    }
    
    state.stage = 'configuring';
    try {
        await bot.deleteMessage(chatId, msg.message_id);
    } catch (e) {
        console.error("Помилка видалення повідомлення:", e.message);
    }
    updateSearchPanel(chatId);
});

// Головний обробник для інлайн-кнопок
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.callback_data;
    const state = userStates[chatId];

    if (!state) {
        bot.answerCallbackQuery(query.id, { text: 'Сесія застаріла. Натисніть /start', show_alert: true });
        return;
    }
    
    if (!data.startsWith('category_')) state.stage = 'configuring';

    if (data === 'set_category') {
        const categoryKeyboard = categoryKeys.map(key => ([{ text: key, callback_data: `category_${categories[key]}|${key}` }]));
        await bot.editMessageReplyMarkup({ inline_keyboard: categoryKeyboard }, { chat_id: chatId, message_id: state.messageId });
    } else if (data.startsWith('category_')) {
        const [path, name] = data.replace('category_', '').split('|');
        state.categoryPath = path;
        state.categoryName = name;
        await updateSearchPanel(chatId);
    } else if (data === 'set_keyword') {
        state.stage = 'awaiting_keyword';
        bot.sendMessage(chatId, "✍️ Введіть ключове слово:").then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(e => {}), 10000));
    } else if (data === 'set_city') {
        state.stage = 'awaiting_city';
        bot.sendMessage(chatId, "🏙️ Введіть назву міста латиницею (напр., `kiev`):").then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(e => {}), 10000));
    } else if (data === 'set_price') {
        state.stage = 'awaiting_price';
        bot.sendMessage(chatId, "💰 Введіть діапазон ціни (напр., `2000-8000`):").then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(e => {}), 10000));
    } else if (data === 'set_sort') {
        const sortKeyboard = [
            [{ text: 'Спочатку новіші', callback_data: 'sort_created_at:desc' }],
            [{ text: 'Спочатку дешевші', callback_data: 'sort_price:asc' }],
            [{ text: 'Спочатку дорожчі', callback_data: 'sort_price:desc' }],
        ];
        await bot.editMessageReplyMarkup({ inline_keyboard: sortKeyboard }, { chat_id: chatId, message_id: state.messageId });
    } else if (data.startsWith('sort_')) {
        state.sort = data.replace('sort_', '');
        await updateSearchPanel(chatId);
    } else if (data === 'search') {
        if (!state.categoryPath || !state.keyword) {
            bot.answerCallbackQuery(query.id, { text: '❗️ Спочатку оберіть категорію та введіть слово!', show_alert: true });
            return;
        }
        await bot.editMessageText('⏳ *Добре, шукаю...*\nЦе може зайняти до 30 секунд.', { chat_id: chatId, message_id: state.messageId, parse_mode: 'Markdown' });
        try {
            const results = await searchOLX({
                query: state.keyword,
                city: state.city,
                minPrice: state.minPrice,
                maxPrice: state.maxPrice,
                sort: state.sort,
                categoryPath: state.categoryPath
            });
            await sendResults(chatId, results);
        } catch (err) {
            console.error('❌ Помилка пошуку на OLX:', err);
            await bot.sendMessage(chatId, `⚠️ Виникла помилка під час пошуку. Можливо, сторінка OLX змінилась або за вашим запитом нічого немає.\n\n_${err.message}_`, {parse_mode: 'Markdown'});
        } finally {
            // Повертаємо панель керування після пошуку
            await updateSearchPanel(chatId);
        }
    }
    
    bot.answerCallbackQuery(query.id);
});

// --- НАЛАШТУВАННЯ СЕРВЕРА (для Render) ---
if (!isLocal) {
    const webhookPath = `/webhook${token}`;
    const fullUrl = `${webhookUrl}${webhookPath}`;
    bot.setWebhook(fullUrl);
    app.post(webhookPath, (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`🚀 Вебхук-сервер запущено на порті ${port}`));
} else {
    console.log('🚀 Бот запущено локально через polling');
}