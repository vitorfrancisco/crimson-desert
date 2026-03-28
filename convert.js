// Converte database.json → database.js para uso direto sem servidor (file://)
const fs = require('fs');
const json = fs.readFileSync('./database.json', 'utf8');
fs.writeFileSync('./database.js', `var DATABASE = ${json};`, 'utf8');
console.log('database.js gerado com sucesso!');
