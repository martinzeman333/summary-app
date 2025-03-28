const express = require('express');
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { OpenAI } = require('openai');
const Parser = require('rss-parser');
const levenshtein = require('fast-levenshtein'); // Přidání knihovny pro Levenshteinovu vzdálenost
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const parser = new Parser();

// Mezipaměť pro uložení sumarizací
const cache = {
    cr: { referat: null, lastUpdated: null },
    world: { referat: null, lastUpdated: null }
};

// Funkce pro formátování data a času
function formatDateTime(date) {
    return date.toLocaleString('cs-CZ', {
        day: 'numeric',
        month: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// Funkce pro výpočet podobnosti titulků
function areTitlesSimilar(title1, title2) {
    const distance = levenshtein.get(title1.toLowerCase(), title2.toLowerCase());
    const maxLength = Math.max(title1.length, title2.length);
    const similarity = 1 - distance / maxLength; // Podobnost v rozmezí 0-1
    return similarity > 0.9; // Pokud je podobnost větší než 90 %, považujeme titulky za duplicitní
}

// Funkce pro sumarizaci
async function generateSummary(type) {
    const wordCount = 3000;
    const maxTokens = Math.round(wordCount * 1.5);

    // Definice RSS zdrojů s názvy (odstraněny problematické odkazy)
    let rssFeeds;
    if (type === 'cr') {
        rssFeeds = [
            { url: 'https://www.irozhlas.cz/rss/irozhlas/section/zpravy-domov', name: 'iRozhlas' },
            { url: 'https://www.novinky.cz/rss', name: 'Novinky.cz' } // Nový zdroj pro ČR
        ];
    } else if (type === 'world') {
        rssFeeds = [
            { url: 'https://www.irozhlas.cz/rss/irozhlas/section/zpravy-svet', name: 'iRozhlas' },
            { url: 'https://ct24.ceskatelevize.cz/rss', name: 'ČT24' },
            { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', name: 'New York Times' },
            { url: 'https://feeds.skynews.com/feeds/rss/world.xml', name: 'Sky News' },
            { url: 'http://feeds.bbci.co.uk/news/world/rss.xml', name: 'BBC News' } // Nový zdroj pro svět
        ];
    } else {
        throw new Error('Neplatný typ sumarizace');
    }

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

            // Kontrola duplicit podle URL
            if (seenUrls.has(articleUrl)) {
                console.log(`Duplicita (URL): ${articleTitle}`);
                continue;
            }

            // Kontrola duplicit podle titulků (přesná shoda)
            if (seenTitles.has(articleTitle)) {
                console.log(`Duplicita (titulek): ${articleTitle}`);
                continue;
            }

            // Kontrola podobnosti titulků
            let isDuplicate = false;
            for (const existingTitle of seenTitles) {
                if (areTitlesSimilar(articleTitle, existingTitle)) {
                    console.log(`Duplicita (podobný titulek): ${articleTitle} ~ ${existingTitle}`);
                    isDuplicate = true;
                    break;
                }
            }
            if (isDuplicate) continue;

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
        throw new Error('Žádné články k sumarizaci');
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
        temperature: 0.5,
    });

    return completion.choices[0].message.content.trim();
}

// Automatická aktualizace každou hodinu
async function updateSummaries() {
    console.log('Spouštím automatickou aktualizaci...');
    try {
        // Aktualizace Novinky ČR
        console.log('Aktualizuji Novinky ČR...');
        const crSummary = await generateSummary('cr');
        cache.cr.referat = crSummary;
        cache.cr.lastUpdated = new Date();
        console.log('Novinky ČR aktualizovány.');

        // Aktualizace Novinky svět
        console.log('Aktualizuji Novinky svět...');
        const worldSummary = await generateSummary('world');
        cache.world.referat = worldSummary;
        cache.world.lastUpdated = new Date();
        console.log('Novinky svět aktualizovány.');
    } catch (error) {
        console.error(`Chyba při automatické aktualizaci: ${error.message}`);
    }
}

// Spuštění první aktualizace při startu serveru
updateSummaries();

// Nastavení automatické aktualizace každou hodinu (60 minut = 60 * 60 * 1000 ms)
setInterval(updateSummaries, 60 * 60 * 1000);

// Endpoint pro získání sumarizace
app.post('/api/summarize-news', async (req, res) => {
    const { type, length } = req.body;

    if (!type || !length) {
        return res.status(400).json({ error: 'Typ a délka jsou povinné' });
    }

    try {
        // Pokud je sumarizace v mezipaměti, vrátíme ji
        if (type === 'cr' && cache.cr.referat) {
            return res.json({
                referat: cache.cr.referat,
                lastUpdated: cache.cr.lastUpdated ? formatDateTime(cache.cr.lastUpdated) : 'Není uvedeno'
            });
        } else if (type === 'world' && cache.world.referat) {
            return res.json({
                referat: cache.world.referat,
                lastUpdated: cache.world.lastUpdated ? formatDateTime(cache.world.lastUpdated) : 'Není uvedeno'
            });
        }

        // Pokud sumarizace není v mezipaměti, vygenerujeme ji
        const referat = await generateSummary(type);
        cache[type].referat = referat;
        cache[type].lastUpdated = new Date();

        res.json({
            referat,
            lastUpdated: formatDateTime(cache[type].lastUpdated)
        });
    } catch (error) {
        console.error(`Chyba: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server běží na portu ${PORT}`));
