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
            });

            if (!response.ok) {
                console.error(`Nepodařilo se načíst stránku ${url}: ${response.statusText}`);
                continue;
            }

            const html = await response.text();
            const dom = new JSDOM(html, { url });
            const reader = new Readability(dom.window.document);
            const article = reader.parse();

            if (article && article.textContent) {
                articles.push({ url, content: article.textContent, title: article.title || 'Bez názvu' });
            } else {
                console.error(`Nepodařilo se extrahovat obsah z ${url}`);
            }
        }

        if (articles.length === 0) {
            throw new Error('Nepodařilo se načíst žádný obsah z uvedených stránek');
        }

        // Spojíme obsah všech článků do jednoho textu
        const combinedContent = articles.map(article => `Obsah z ${article.url} (Titulek: ${article.title}):\n${article.content}`).join('\n\n');

        // Definujeme popis sumarizace podle typu
        const summaryDescription = type === 'cr'
            ? 'nejnovějších a nejzajímavějších zpráv z České republiky'
            : 'nejnovějších a nejzajímavějších zpráv ze světa';

        // Vytvoříme prompt pro OpenAI
        const prompt = `Prohledej následující texty z více zdrojů a vytvoř seznam ${summaryDescription}. Pro každou zprávu uveď:
        - Krátký titulek (max. 10 slov),
        - Stručné shrnutí (2-3 věty, zdůrazni podstatné informace),
        - Odkaz na původní článek (URL).
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
