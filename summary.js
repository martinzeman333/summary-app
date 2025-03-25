const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { OpenAI } = require('openai');

// Inicializace OpenAI s API klíčem (klíč bude v .env souboru)
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

module.exports = async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL je povinná' });
    }

    try {
        // Načtení obsahu URL
        const response = await fetch(url);
        const html = await response.text();
        const $ = cheerio.load(html);
        const textContent = $('body').text().replace(/\s+/g, ' ').trim(); // Extrakce textu z HTML

        if (!textContent) {
            throw new Error('Nepodařilo se načíst obsah stránky');
        }

        // Volání OpenAI API
        const completion = await openai.completions.create({
            model: 'text-davinci-003', // Nebo jiný model, např. 'gpt-3.5-turbo'
            prompt: `Vytvoř souhrn následujícího textu v češtině a vypiš hlavní myšlenky jako seznam: ${textContent.slice(0, 4000)}`, // Omezení délky kvůli limitům API
            max_tokens: 500,
            temperature: 0.7,
        });

        const resultText = completion.choices[0].text.trim();
        const summaryMatch = resultText.match(/Souhrn:([\s\S]*?)(Hlavní myšlenky:|$)/i);
        const pointsMatch = resultText.match(/Hlavní myšlenky:([\s\S]*)/i);

        const summary = summaryMatch ? summaryMatch[1].trim() : resultText;
        const mainPoints = pointsMatch ? pointsMatch[1].split('\n').filter(line => line.trim()).map(line => line.replace(/^- /, '')) : [];

        res.json({ summary, mainPoints });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};