const express = require('express');
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { OpenAI } = require('openai');
const Parser = require('rss-parser');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const parser = new Parser();

app.post('/api/summarize-news', async (req, res) => {
    const { type, length } = req.body;

    if (!type || !length) {
        return res.status(400).json({ error: 'Typ a délka jsou povinné' });
    }

    const wordCount = 3000;
    const maxTokens = Math.round(wordCount * 1.5);

    // Definice RSS zdrojů
    let rssFeeds;
    if (type === 'cr') {
        rssFeeds = [
            'https://www.irozhlas.cz/rss/irozhlas/section/zpravy-domov',
            'https://www.seznamzprav.cz/zpravy.php?rubrika=domaci'
        ];
    } else if (type === 'world') {
        rssFeeds = [
            'https://www.irozhlas.cz/rss/irozhlas/section/zpravy-svet',
            'https://www.seznamzprav.cz/zpravy.php?rubrika=zahranici',
            'https://ct24.ceskatelevize.cz/rss',
            'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
            'https://feeds.skynews.com/feeds/rss/world.xml'
        ];
    } else {
        return res.status(400).json({ error: 'Neplatný typ sumarizace' });
    }

    try {
        const articles = [];
        const seenUrls = new Set();
        const seenTitles = new Set();

        // Načítání RSS feedů
        for (const feedUrl of rssFeeds) {
            console.log(`Načítám RSS: ${feedUrl}`);
            let feed;
            try {
                feed = await parser.parseURL(feedUrl);
            } catch (err) {
                console.error(`Chyba RSS ${feedUrl}: ${err.message}`);
                continue;
            }

            if (!feed.items || feed.items.length === 0) continue;

            // Omezení na 10 nejnovějších článků
            for (const item of feed.items.slice(0, 10)) {
                const articleUrl = item.link;
                const articleTitle = item.title || 'Bez názvu';

                // Kontrola duplicit
                if (seenUrls.has(articleUrl) || seenTitles.has(articleTitle)) {
                    console.log(`Duplicita: ${articleTitle}`);
                    continue;
                }

                seenUrls.add(articleUrl);
                seenTitles.add(articleTitle);

                // Načtení obsahu článku
                try {
                    const response = await fetch(articleUrl, {
                        headers: { 'User-Agent': 'Mozilla/5.0' },
                        timeout: 5000,
                    });
                    if (!response.ok) continue;

                    const html = await response.text();
                    const dom = new JSDOM(html, { url: articleUrl });
                    const reader = new Readability(dom.window.document);
                    const article = reader.parse();

                    if (article && article.textContent) {
                        articles.push({
                            url: articleUrl,
                            content: article.textContent,
                            title: article.title || articleTitle
                        });
                    }
                } catch (err) {
                    console.error(`Chyba článku ${articleUrl}: ${err.message}`);
                }
            }
        }

        if (articles.length === 0) {
            return res.status(500).json({ error: 'Žádné články k sumarizaci' });
        }

        // Kombinace obsahu pro sumarizaci
        const combinedContent = articles
            .map(a => `Z ${a.url} (Titulek: ${a.title}):\n${a.content}`)
            .join('\n\n');

        const summaryDescription = type === 'cr'
            ? 'nejnovějších zpráv z ČR'
            : 'nejnovějších zpráv ze světa';

        const prompt = `Vytvoř seznam ${summaryDescription} z textů. Pro každou zprávu uveď:
        - Krátký titulek (max. 10 slov),
        - Shrnutí (4-5 vět, v češtině).
        Seznam: 5-10 zpráv, délka ~${wordCount} slov. Texty: ${combinedContent.slice(0, 8000)}`;

        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxTokens,
            temperature: 0.7,
        });

        const referat = completion.choices[0].message.content.trim();
        res.json({ referat });
    } catch (error) {
        console.error(`Chyba: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server běží na portu ${PORT}`));
