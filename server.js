const express = require('express');
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { OpenAI } = require('openai');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

app.post('/api/summary', async (req, res) => {
    const { url, model, length } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL je povinná' });
    }

    if (!model) {
        return res.status(400).json({ error: 'Model je povinný' });
    }

    if (!length) {
        return res.status(400).json({ error: 'Délka je povinná' });
    }

    const validModels = ['gpt-3.5-turbo', 'gpt-4o-mini'];
    if (!validModels.includes(model)) {
        return res.status(400).json({ error: 'Neplatný model' });
    }

    const lengthMap = {
        short: 100,
        medium: 200,
        long: 300,
    };

    const wordCount = lengthMap[length] || 200;
    const maxTokens = Math.round(wordCount * 1.5);

    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            },
            timeout: 10000, // Timeout 10 sekund pro fetch
        });

        if (!response.ok) {
            throw new Error(`Nepodařilo se načíst stránku: ${response.statusText}`);
        }

        const html = await response.text();
        const dom = new JSDOM(html, { url });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (!article || !article.textContent) {
            throw new Error('Nepodařilo se extrahovat obsah článku');
        }

        const textContent = article.textContent;

        const completion = await openai.chat.completions.create({
            model: model,
            messages: [
                {
                    role: 'user',
                    content: `Napiš referát v češtině na základě následujícího textu. Referát by měl být souvislý text o délce přibližně ${wordCount} slov, shrnující hlavní myšlenky článku. Na konci přidej 2-3 citace z textu (přímé věty nebo úryvky z článku, které podporují tvé tvrzení). Pokud text není v češtině, přelož citace do češtiny. Text: ${textContent.slice(0, 4000)}`
                }
            ],
            max_tokens: maxTokens,
            temperature: 0.7,
        });

        const referat = completion.choices[0].message.content.trim();
        res.json({ referat });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/summarize-news', async (req, res) => {
    const { urls, model, length, type } = req.body;

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ error: 'Seznam URL je povinný' });
    }

    if (!model) {
        return res.status(400).json({ error: 'Model je povinný' });
    }

    if (!length) {
        return res.status(400).json({ error: 'Délka je povinná' });
    }

    if (!type) {
        return res.status(400).json({ error: 'Typ sumarizace je povinný' });
    }

    const validModels = ['gpt-3.5-turbo', 'gpt-4o-mini'];
    if (!validModels.includes(model)) {
        return res.status(400).json({ error: 'Neplatný model' });
    }

    // Pro speciální sumarizaci novinek nastavíme délku na 3000 slov
    const wordCount = 3000;
    const maxTokens = Math.round(wordCount * 1.5);

    try {
        // Načteme obsah ze všech URL
        const articles = [];

        for (const url of urls) {
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                },
                timeout: 10000, // Timeout 10 sekund pro fetch
            });

            if (!response.ok) {
                console.error(`Nepodařilo se načíst stránku ${url}: ${response.statusText}`);
                continue;
            }

            const html = await response.text();
            const dom = new JSDOM(html, { url });
            const document = dom.window.document;

            // Extrahujeme odkazy na články z homepage
            const links = Array.from(document.querySelectorAll('a'))
                .map(a => {
                    const href = a.href;
                    // Filtrujeme pouze odkazy, které pravděpodobně vedou na články
                    if (href && href.startsWith('http') && !href.includes('category') && !href.includes('tag') && !href.includes('author')) {
                        return href;
                    }
                    return null;
                })
                .filter(link => link !== null);

            // Načteme obsah jednotlivých článků (max. 3 na stránku) paralelně
            const articlePromises = links.slice(0, 3).map(async (articleUrl) => {
                try {
                    const articleResponse = await fetch(articleUrl, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                        },
                        timeout: 10000, // Timeout 10 sekund pro fetch
                    });

                    if (!articleResponse.ok) {
                        console.error(`Nepodařilo se načíst článek ${articleUrl}: ${articleResponse.statusText}`);
                        return null;
                    }

                    const articleHtml = await articleResponse.text();
                    const articleDom = new JSDOM(articleHtml, { url: articleUrl });
                    const reader = new Readability(articleDom.window.document);
                    const article = reader.parse();

                    if (article && article.textContent) {
                        return {
                            url: articleUrl,
                            content: article.textContent,
                            title: article.title || 'Bez názvu'
                        };
                    } else {
                        console.error(`Nepodařilo se extrahovat obsah z ${articleUrl}`);
                        return null;
                    }
                } catch (err) {
                    console.error(`Chyba při načítání článku ${articleUrl}: ${err.message}`);
                    return null;
                }
            });

            // Počkáme na všechny články paralelně
            const fetchedArticles = await Promise.all(articlePromises);
            // Přidáme pouze úspěšně načtené články
            fetchedArticles.forEach(article => {
                if (article) {
                    articles.push(article);
                }
            });
        }

        if (articles.length === 0) {
            throw new Error('Nepodařilo se načíst žádný obsah z uvedených stránek');
        }

        // Spojíme obsah všech článků do jednoho textu
        const combinedContent = articles.map(article => `Obsah z ${article.url} (Titulek: ${article.title}):\n${article.content}`).join('\n\n');

        // Definujeme popis sumarizace podle typu
        let summaryDescription;
        if (type === 'cr') {
            summaryDescription = 'nejnovějších a nejzajímavějších zpráv z České republiky';
        } else if (type === 'world') {
            summaryDescription = 'nejnovějších a nejzajímavějších zpráv ze světa';
        } else if (type === 'homepage') {
            summaryDescription = 'nejnovějších a nejzajímavějších zpráv z vybrané zpravodajské stránky';
        } else {
            throw new Error('Neplatný typ sumarizace');
        }

        // Vytvoříme prompt pro OpenAI (bez odkazů na původní články)
        const prompt = `Prohledej následující texty z více zdrojů a vytvoř seznam ${summaryDescription}. Pro každou zprávu uveď:
        - Krátký titulek (max. 10 slov),
        - Podrobné shrnutí (4-5 vět, zdůrazni podstatné informace, přelož do češtiny, pokud je text v jiném jazyce).
        Seznam by měl obsahovat 5-10 nejzajímavějších zpráv, celkově o délce přibližně ${wordCount} slov. Nepoužívej nadpisy jako ### Závěr nebo ### Citace. Texty: ${combinedContent.slice(0, 8000)}`;

        const completion = await openai.chat.completions.create({
            model: model,
            messages: [
                {
                    role: 'user',
                    content: prompt
                }
            ],
            max_tokens: maxTokens,
            temperature: 0.7,
        });

        const referat = completion.choices[0].message.content.trim();
        res.json({ referat });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server běží na portu ${PORT}`);
});
