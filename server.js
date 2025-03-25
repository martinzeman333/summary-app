const express = require('express');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { OpenAI } = require('openai');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Pouze jedna deklarace openai
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

app.post('/api/summary', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL je povinná' });
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
        const $ = cheerio.load(html);
        const textContent = $('body').text().replace(/\s+/g, ' ').trim();
        console.log('Textový obsah:', textContent.slice(0, 100));

        if (!textContent) {
            throw new Error('Nepodařilo se načíst obsah stránky');
        }

        const completion = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
                { role: 'user', content: `Vytvoř souhrn následujícího textu v češtině a vypiš hlavní myšlenky jako seznam: ${textContent.slice(0, 4000)}` }
            ],
            max_tokens: 500,
            temperature: 0.7,
        });
        console.log('Odpověď OpenAI:', completion);

        const resultText = completion.choices[0].message.content.trim();
        const summaryMatch = resultText.match(/Souhrn:([\s\S]*?)(Hlavní myšlenky:|$)/i);
        const pointsMatch = resultText.match(/Hlavní myšlenky:([\s\S]*)/i);

        const summary = summaryMatch ? summaryMatch[1].trim() : resultText;
        const mainPoints = pointsMatch ? pointsMatch[1].split('\n').filter(line => line.trim()).map(line => line.replace(/^- /, '')) : [];

        res.json({ summary, mainPoints });
    } catch (error) {
        console.log(error);
        res.status(500).json({ error: error.message, details: error.stack });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server běží na portu ${PORT}`);
});
