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

    // Definice RSS zdrojů s názvy
    let rssFeeds;
    if (type === 'cr') {
        rssFeeds = [
            { url: 'https://www.irozhlas.cz/rss/irozhlas/section/zpravy-domov', name: 'iRozhlas' },
            { url: 'https://www.seznamzprav.cz/zpravy.php?rubrika=domaci', name: 'Seznam Zprávy' }
        ];
    } else if (type === 'world') {
        rssFeeds = [
            { url: 'https://www.irozhlas.cz/rss/irozhlas/section/zpravy-svet', name: 'iRozhlas' },
            { url: 'https://www.seznamzprav.cz/zpravy.php?rubrika=zahranici', name: 'Seznam Zprávy' },
            { url: 'https://ct24.ceskatelevize.cz/rss', name: 'ČT24' },
            { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', name: 'New York Times' },
            { url: 'https://feeds.skynews.com/feeds/rss/world.xml', name: 'Sky News' }
        ];
    } else {
        return res.status(400).json({ error: 'Neplatný typ sumarizace' });
    }

    try {
        let allArticles = [];
        const seenUrls = new Set();
        const seenTitles = new Set();

        // Načítání RSS feedů
        for (const feed of rssFeeds) {
            console.log(`Načítám RSS: ${feed.url}`);
            let feedData;
            try {
                feedData = await parser.parseURL(feed.url);
            } catch (err) {
                console.error(`Chyba RSS ${feed.url}: ${err.message}`);
                continue;
            }

            if (!feedData.items || feedData.items.length === 0) continue;

            // Přidání článků s datem a zdrojem
            for (const item of feedData.items.slice(0, 10)) {
                const articleUrl = item.link;
                const articleTitle = item.title || 'Bez názvu';
                const pubDate = item.pubDate || item.isoDate || 'Není uvedeno datum';

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
                        allArticles.push({
                            url: articleUrl,
                            content: article.textContent,
                            title: article.title || articleTitle,
                            pubDate: pubDate,
                            source: feed.name
                        });
                    }
                } catch (err) {
                    console.error(`Chyba článku ${articleUrl}: ${err.message}`);
                }
            }
        }

        // Seřazení článků podle data (od nejnovějších)
        allArticles.sort((a, b) => {
            const dateA = new Date(a.pubDate);
            const dateB = new Date(b.pubDate);
            return dateB - dateA; // Od nejnovějšího po nejstarší
        });

        if (allArticles.length === 0) {
            return res.status(500).json({ error: 'Žádné články k sumarizaci' });
        }

        // Kombinace obsahu pro sumarizaci
        const combinedContent = allArticles
            .map(a => `Z ${a.url} (Titulek: ${a.title}, Zdroj: ${a.source}, Datum: ${a.pubDate}):\n${a.content}`)
            .join('\n\n');

        const summaryDescription = type === 'cr'
            ? 'nejnovějších zpráv z ČR'
            : 'nejnovějších zpráv ze světa';

        const prompt = `Vytvoř seznam ${summaryDescription} z textů. Pro každou zprávu uveď:
        - Krátký titulek (max. 10 slov),
        - Shrnutí (4-5 vět, v češtině),
        - Informaci o zdroji a datu ve formátu: *(Zdroj: [zdroj], Datum: [datum])* (např. *(Zdroj: iRozhlas, Datum: 28. 3. 2025)*).
        Sumarizuj striktně na základě poskytnutých dat, nevymýšlej si žádné informace. Pokud nějaká informace chybí, uveď to v shrnutí (např. "Datum vydání není uvedeno"). Seznam: 5-10 zpráv, délka ~${wordCount} slov. Texty: ${combinedContent.slice(0, 8000)}`;

        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: maxTokens,
            temperature: 0.5, // Snížíme teplotu, aby model méně "kreativně" vymýšlel
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
