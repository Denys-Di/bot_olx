import TelegramBot from 'node-telegram-bot-api';
import puppeteer from 'puppeteer-core';
import chromium from 'chrome-aws-lambda';
import express from 'express';

const token = process.env.TOKEN;
const isLocal = !process.env.RENDER;

const bot = new TelegramBot(token, { polling: isLocal });
const app = express();
app.use(express.json());

const userStates = {};
const categories = {
  '📱 Телефони': 'телефон',
  '💻 Ноутбуки': 'ноутбук',
  '🎧 Навушники': 'навушники'
};

async function searchOLX(query, minPrice, maxPrice) {
  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath || '/usr/bin/google-chrome',
    headless: true
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

      const title = el.querySelector('h6')?.innerText || '—';
      const price = el.querySelector('[data-testid="ad-price"]')?.innerText || 'Ціна не вказана';
      const link = el.querySelector('a')?.href || '#';
      const image = el.querySelector('img')?.src || null;

      if (title && link) items.push({ title, price, link, image });
    });

    return items;
  });

  await browser.close();
  return results;
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const state = userStates[chatId] || {};

  if (text === '/start') {
    userStates[chatId] = { stage: 'choose_category' };
    return bot.sendMessage(chatId, 'Оберіть категорію:', {
      reply_markup: {
        keyboard: [['📱 Телефони', '💻 Ноутбуки', '🎧 Навушники']],
        resize_keyboard: true,
        one_time_keyboard: false
      }
    });
  }

  if (categories[text]) {
    userStates[chatId] = { stage: 'enter_keyword', category: categories[text] };
    return bot.sendMessage(chatId, `🔎 Введіть ключове слово:`, { parse_mode: 'Markdown' });
  }

  if (state.stage === 'enter_keyword') {
    userStates[chatId] = { ...state, stage: 'enter_price', keyword: text };
    return bot.sendMessage(chatId, '💰 Введіть діапазон ціни `2000-8000` (або натисніть Enter):', {
      parse_mode: 'Markdown'
    });
  }

  if (state.stage === 'enter_price') {
    let minPrice = '', maxPrice = '';
    const match = text.match(/(\d+)\s*-\s*(\d+)/);
    if (match) {
      minPrice = match[1];
      maxPrice = match[2];
    }

    const query = `${state.category} ${state.keyword}`;
    bot.sendMessage(chatId, `⏳ Пошук *${query}*`, { parse_mode: 'Markdown' });

    try {
      const results = await searchOLX(query, minPrice, maxPrice);
      if (results.length > 0) {
        for (const item of results) {
          const msgText = `📌 *${item.title}*\n💵 *${item.price}*\n🔗 [Переглянути](${item.link})`;
          if (item.image) {
            await bot.sendPhoto(chatId, item.image, {
              caption: msgText,
              parse_mode: 'Markdown'
            });
          } else {
            await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
          }
        }
      } else {
        await bot.sendMessage(chatId, '😕 Нічого не знайдено.');
      }
    } catch (err) {
      console.error('❌ OLX Error:', err);
      await bot.sendMessage(chatId, `⚠️ Помилка: ${err.message}`);
    }

    userStates[chatId] = null;
  }
});

// Webhook (для Render)
if (!isLocal) {
  const webhookPath = '/webhook';
  const fullUrl = `${process.env.RENDER_EXTERNAL_URL}${webhookPath}`;
  bot.setWebhook(fullUrl);
  app.post(webhookPath, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`🚀 Webhook сервер працює на ${port}`));
} else {
  console.log('🚀 Бот запущено локально через polling');
}
