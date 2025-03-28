const express = require('express');
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { OpenAI } = require('openai');
const Parser = require('rss-parser');
const levenshtein = require('fast-levenshtein');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const parser = new Parser();

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
    const similarity = 1 - distance / maxLength;
    return similarity > 0.9;
}

// Funkce pro kontrolu, zda článek patří do kategorie "ČR"
function isArticleFromCR(article) {
    const crKeywords = [
        'česko', 'praha', 'brno', 'ostrava', 'plzeň', 'liberec', 'olomouc',
        'česká republika', 'čr', 'karlovy vary', 'hradec králové', 'pardubice'
    ];
    const title = (article.title || '').toLowerCase();
    const content = (article.content || '').toLowerCase();

    return crKeywords.some(keyword => title.includes(keyword) || content.includes(keyword));
}

// Funkce pro sumarizaci
async function generateSummary(type) {
    const wordCount = 3000;
    const maxTokens = Math.round(wordCount * 1.5);

    // Definice RSS zdrojů s názvy
    let rssFeeds;
    if (type === 'cr') {
        rssFeeds = [
            { url: 'https://www.irozhlas.cz/rss/irozhlas/section/zpravy-domov', name: 'iRozhlas' },
            { url: 'https://www.novinky.cz/rss/domaci', name: 'Novinky.cz' }
        ];
    } else if (type === 'world') {
        rssFeeds = [
            { url: 'https://www.irozhlas.cz/rss/irozhlas/section/zpravy-svet', name: 'iRozhlas' },
            { url: 'https://ct24.ceskatelevize.cz/rss', name: 'ČT24' },
            { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', name: 'New York Times' },
            { url: 'https://feeds.skynews.com/feeds/rss/world.xml', name: 'Sky News' },
            { url: 'http://feeds.bbci.co.uk/news/world/rss.xml', name: 'BBC News' }
        ];
    } else if (type === 'homepage') {
        // Pro homepage budeme očekávat URL v těle požadavku
        return;
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
            let articleContent = null;
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
                    articleContent = {
                        url: articleUrl,
                        content: article.textContent,
                        title: article.title || articleTitle,
                        pubDate: pubDate,
                        source: feed.name
                    };
                }
            } catch (err) {
                console.error(`Chyba článku ${articleUrl}: ${err.message}`);
                continue;
            }

            if (!articleContent) continue;

            // Filtrování obsahu pro "Novinky ČR"
            if (type === 'cr') {
                if (!isArticleFromCR(articleContent)) {
                    console.log(`Článek ${articleTitle} není z ČR, přeskakuji.`);
                    continue;
                }
            }

            allArticles.push(articleContent);
        }
    }

    // Seřazení článků podle data (od nejnovějších)
    allArticles.sort((a, b) => {
        const dateA = new Date(a.pubDate);
        const dateB = new Date(b.pubDate);
        return dateB - dateA;
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
    - Krátký titulek (max. 10 slov, přelož do češtiny, pokud je původní titulek v jiném jazyce),
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

// Endpoint pro získání sumarizace
app.post('/api/summarize-news', async (req, res) => {
    const { type, length, urls } = req.body;

    if (!type || !length) {
        return res.status(400).json({ error: 'Typ a délka jsou povinné' });
    }

    try {
        if (type === 'homepage') {
            if (!urls || !urls.length) {
                return res.status(400).json({ error: 'URL adresy jsou povinné pro sumarizaci homepage' });
            }

            let allArticles = [];
            for (const url of urls) {
                console.log(`Načítám homepage: ${url}`);
                try {
                    const response = await fetch(url, {
                        headers: { 'User-Agent': 'Mozilla/5.0' },
                        timeout: 5000,
                    });
                    if (!response.ok) continue;

                    const html = await response.text();
                    const dom = new JSDOM(html, { url });
                    const reader = new Readability(dom.window.document);
                    const article = reader.parse();

                    if (article && article.textContent) {
                        allArticles.push({
                            url: url,
                            content: article.textContent,
                            title: article.title || 'Bez názvu',
                            pubDate: 'Není uvedeno datum',
                            source: url
                        });
                    }
                } catch (err) {
                    console.error(`Chyba při načítání homepage ${url}: ${err.message}`);
                    continue;
                }
            }

            if (allArticles.length === 0) {
                throw new Error('Žádné články k sumarizaci z homepage');
            }

            const combinedContent = allArticles
                .map(a => `Z ${a.url} (Titulek: ${a.title}, Zdroj: ${a.source}, Datum: ${a.pubDate}):\n${a.content}`)
                .join('\n\n');

            const wordCount = 3000;
            const maxTokens = Math.round(wordCount * 1.5);

            const prompt = `Vytvoř seznam nejnovějších zpráv z homepage. Pro každou zprávu uveď:
            - Krátký titulek (max. 10 slov, přelož do češtiny, pokud je původní titulek v jiném jazyce),
            - Shrnutí (4-5 vět, v češtině),
            - Informaci o zdroji a datu ve formátu: *(Zdroj: [zdroj], Datum: [datum])* (např. *(Zdroj: iRozhlas, Datum: 28. 3. 2025)*).
            Sumarizuj striktně na základě poskytnutých dat, nevymýšlej si žádné informace. Pokud nějaká informace chybí, uveď to v shrnutí (např. "Datum vydání není uvedeno"). Seznam: 5-10 zpráv, délka ~${wordCount} slov. Texty: ${combinedContent.slice(0, 8000)}`;

            const completion = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: maxTokens,
                temperature: 0.5,
            });

            return res.json({
                referat: completion.choices[0].message.content.trim(),
                lastUpdated: formatDateTime(new Date())
            });
        }

        const referat = await generateSummary(type);
        res.json({
            referat,
            lastUpdated: formatDateTime(new Date())
        });
    } catch (error) {
        console.error(`Chyba: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server běží na portu ${PORT}`));
