const express = require('express');
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { OpenAI } = require('openai');

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

    const validLengths = ['short', 'medium', 'long'];
    if (!validLengths.includes(length)) {
        return res.status(400).json({ error: 'Neplatná délka' });
    }

    try {
        console.log('Načítám URL:', url);
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            },
        });
        console.log('Odpověď z URL:', response.status, response.statusText);
        const html = await response.text();
        console.log('HTML načteno, délka:', html.length);

        const dom = new JSDOM(html, { url });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (!article || !article.textContent) {
            throw new Error('Nepodařilo se načíst obsah článku');
        }

        const textContent = article.textContent.replace(/\s+/g, ' ').trim();
        console.log('Textový obsah článku:', textContent.slice(0, 100));

        // Nastavení délky podle výběru
        let wordCount;
        let maxTokens;
        switch (length) {
            case 'short':
                wordCount = 100;
                maxTokens = 300;
                break;
            case 'medium':
                wordCount = 200;
                maxTokens = 600;
                break;
            case 'long':
                wordCount = 300;
                maxTokens = 900;
                break;
            default:
                wordCount = 200;
                maxTokens = 600;
        }

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

        console.log('Odpověď OpenAI:', completion);

        const referat = completion.choices[0].message.content.trim();

        res.json({ referat });
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: error.message, details: error.stack });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server běží na portu ${PORT}`);
});
