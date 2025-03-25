// script.js
async function generateSummary() {
    const content = document.getElementById('contentInput').value;
    const outputDiv = document.getElementById('output');

    if (!content) {
        outputDiv.innerHTML = '<p style="color: red;">Prosím, vložte obsah stránky.</p>';
        return;
    }

    outputDiv.innerHTML = '<p>Generuji souhrn, prosím čekejte...</p>';

    try {
        const response = await fetch('https://api.openai.com/v1/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: 'text-davinci-003', // Nebo jiný model, např. 'gpt-3.5-turbo' (zkontrolujte dostupnost)
                prompt: `Vytvoř souhrn následujícího textu v češtině a vypiš hlavní myšlenky jako seznam: ${content}`,
                max_tokens: 500,
                temperature: 0.7
            })
        });

        if (!response.ok) {
            throw new Error('Chyba při volání OpenAI API: ' + response.statusText);
        }

        const data = await response.json();
        const resultText = data.choices[0].text.trim();

        // Rozdělení souhrnu a hlavních myšlenek (předpokládáme, že OpenAI vrátí text ve formátu "Souhrn: ... Hlavní myšlenky: ...")
        const summaryMatch = resultText.match(/Souhrn:([\s\S]*?)(Hlavní myšlenky:|$)/i);
        const pointsMatch = resultText.match(/Hlavní myšlenky:([\s\S]*)/i);

        const summary = summaryMatch ? summaryMatch[1].trim() : resultText;
        const mainPoints = pointsMatch ? pointsMatch[1].split('\n').filter(line => line.trim()).map(line => line.replace(/^- /, '')) : [];

        outputDiv.innerHTML = `
            <h2>Souhrn obsahu</h2>
            <p>${summary}</p>
            <h3>Hlavní myšlenky</h3>
            <ul>${mainPoints.map(point => `<li>${point}</li>`).join('')}</ul>
        `;
    } catch (error) {
        outputDiv.innerHTML = `<p style="color: red;">Chyba: ${error.message}</p>`;
    }
}