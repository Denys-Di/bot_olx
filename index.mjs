import TelegramBot from 'node-telegram-bot-api';
import puppeteer from 'puppeteer-core';
import chromium from 'chrome-aws-lambda';
const { launch } = chromium;
import http from 'http';

const token = process.env.TOKEN;
const bot = new TelegramBot(token, { polling: true });
const userStates = {};

const categories = {
  '📱 Телефони': 'телефон',
  '💻 Ноутбуки': 'ноутбук',
  '🎧 Навушники': 'навушники'
};

async function searchOLX(query, minPrice, maxPrice) {
  let browser;

  try {
    browser = await launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath,
      headless: true,
    });

    const page = await browser.newPage();

    let searchUrl = `https://www.olx.ua/uk/list/?search[order]=created_at:desc&q=${encodeURIComponent(query)}`;
    if (minPrice) searchUrl += `&search[filter_float_price:from]=${minPrice}`;
    if (maxPrice) searchUrl += `&search[filter_float_price:to]=${maxPrice}`;

    await page.goto(searchUrl, { waitUntil: 'networkidle0' });
    await new Promise(resolve => setTimeout(resolve, 3000));

    const results = await page.evaluate(() => {
      const items = [];
      const cards = document.querySelectorAll('div[data-cy="l-card"]');

      cards.forEach((el, i) => {
        if (i >= 20) return;

        const titleEl = el.querySelector('h6') || el.querySelector('h6 span');
        const title = titleEl?.innerText || '—';

        const priceEl = el.querySelector('[data-testid="ad-price"]');
        const price = priceEl?.innerText || 'Ціна не вказана';

        const linkEl = el.querySelector('a');
        const link = linkEl?.href || '#';

        const imgEl = el.querySelector('img');
        const image = imgEl?.src || null;

        if (title && link) {
          items.push({ title, price, link, image });
        }
      });

      return items;
    });

    return results;
  } catch (error) {
    console.error('Помилка під час пошуку на OLX:', error);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const state = userStates[chatId] || {};

  console.log(`Отримано повідомлення від ${chatId}: "${text}", поточний стан:`, state);

  if (text === '/start') {
    userStates[chatId] = { stage: 'choose_category' };
    return bot.sendMessage(chatId, 'Оберіть категорію:', {
      reply_markup: {
        keyboard: [
          ['📱 Телефони', '💻 Ноутбуки', '🎧 Навушники']
        ],
        resize_keyboard: true,
        one_time_keyboard: false
      }
    });
  }

  if (categories[text]) {
    console.log(`Користувач ${chatId} обрав категорію: "${text}" (${categories[text]})`);
    userStates[chatId] = {
      stage: 'enter_keyword',
      category: categories[text],
      categoryName: text
    };
    return bot.sendMessage(chatId, `🔎 Ви обрали *${text}*\nВведіть ключове слово:`, {
      parse_mode: 'Markdown'
    });
  }

  if (state.stage === 'enter_keyword') {
    userStates[chatId] = {
      ...state,
      stage: 'enter_price',
      keyword: text
    };
    return bot.sendMessage(chatId, '💰 Введіть діапазон ціни у форматі: `2000-8000`\n(або натисніть Enter, щоб пропустити)', {
      parse_mode: 'Markdown'
    });
  }

  if (state.stage === 'enter_price') {
    let minPrice = '';
    let maxPrice = '';

    const match = text.match(/(\d+)\s*-\s*(\d+)/);
    if (match) {
      minPrice = match[1];
      maxPrice = match[2];
    }

    const fullQuery = `${state.category} ${state.keyword}`;
    bot.sendMessage(chatId, `⏳ Пошук: *${fullQuery}*`, { parse_mode: 'Markdown' });

    try {
      const results = await searchOLX(fullQuery, minPrice, maxPrice);

      if (results.length > 0) {
        for (const item of results) {
          const message = `📌 *${item.title}*\n💵 *${item.price}*\n🔗 [Переглянути на OLX](${item.link})`;
          if (item.image) {
            await bot.sendPhoto(chatId, item.image, {
              caption: message,
              parse_mode: 'Markdown'
            });
          } else {
            await bot.sendMessage(chatId, message, {
              parse_mode: 'Markdown'
            });
          }
        }
      } else {
        await bot.sendMessage(chatId, '😕 Нічого не знайдено.');
      }
    } catch (err) {
      console.error('❌ Помилка:\n', err);
      await bot.sendMessage(chatId, `⚠️ Помилка: ${err.message}`);
    }

    userStates[chatId] = null;
    return;
  }

  return bot.sendMessage(chatId, 'Напишіть /start, щоб розпочати 🔁');
});

// Фіктивний сервер для Render (необхідний для Web Service)
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Bot is running!');
}).listen(process.env.PORT || 3000);