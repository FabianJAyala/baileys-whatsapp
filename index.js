// Express REST API, MySQl, JSON parse, Baileys WhatsApp and dotenv libraries
const express = require('express');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const { useMultiFileAuthState, makeWASocket } = require("@whiskeysockets/baileys");
require('dotenv').config();

// Database Configuration
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    connectionLimit: 10
};

// App port
const app = express();
const port = 7000;

// JSON parse
app.use(bodyParser.json());

// Sock definition as Baileys WhatsApp connection
let sock;

// Create a connection pool for the database
const pool = mysql.createPool(dbConfig);

// Async function to connect to WhatsApp web via QR
async function initializeWhatsAppConnection() {
    // Creating and saving the state of the connection
    const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
    // If not connected, display the QR code to be scanned
    sock = makeWASocket({
        printQRInTerminal: true,
        auth: state,
    });
    // Updating the credentials and the status of the connection
    sock.ev.on("creds.update", saveCreds);
    // Checking the connection, in case closes tries to reconnect
    sock.ev.on("connection.update", (update) => {
        if (update.connection === "close") {
            initializeWhatsAppConnection();
        }
    });
    // Checking for received messages
    sock.ev.on("messages.upsert", async (m) => {
        // Getting the last message received
        const message = m.messages[0];
        // In case message is from own number, do nothing
        if (message.key.fromMe) return;
        // Formatting the incoming WhatsApp number to WhatsApp JID
        const fromNumber = message.key.remoteJid.replace(/@s.whatsapp.net$/, '');
        // Retrieve conversation state from the database
        const conversationState = await getConversationState(fromNumber);
        // Checks if the message is from a number in the database states
        if (conversationState) {
            // Handle the incoming message
            await handleIncomingMessage(conversationState, fromNumber, message);
        }
    });
}

// Async function to execute queries using the connection pool
async function executeQuery(sql, params) {
    const connection = await pool.getConnection();
    try {
        const [rows] = await connection.execute(sql, params);
        return rows;
    } finally {
        connection.release();
    }
}

// Async function to save the conversation state in the database
async function saveConversationState(phoneNumber, state) {
    await executeQuery(
        'INSERT INTO conversation_states (phone_number, state) VALUES (?, ?) ' +
        'ON DUPLICATE KEY UPDATE state = VALUES(state)',
        [phoneNumber, JSON.stringify(state)]
    );
}

// Async function to get conversation state from the database
async function getConversationState(phoneNumber) {
    const rows = await executeQuery(
        'SELECT state FROM conversation_states WHERE phone_number = ?',
        [phoneNumber]
    );
    if (rows.length > 0) {
        return JSON.parse(rows[0].state);
    }
    return null;
}

// Async function to delete conversation state from the database
async function deleteConversationState(phoneNumber) {
    await executeQuery(
        'DELETE FROM conversation_states WHERE phone_number = ?',
        [phoneNumber]
    );
}

// Async function to handle incoming messages
async function handleIncomingMessage(conversationState, phoneNumber, message) {
    // Converts the phone number to WhatsApp JID
    const jid = phoneNumber + '@s.whatsapp.net';
    // Verifies the type of the upcoming message
    const text = message.message.conversation || message.message.extendedTextMessage?.text;
    // Checks if the message is in text format
    if (!!text) {
        // Check if is the first response of the survey
        if (!conversationState.hasHandledFirstResponse) {
            // Saves the reponse in the database
            await saveResponse(phoneNumber, text, true);
            // Delays the message by 1 second and send the second question
            setTimeout(async () => {
                await sock.sendMessage(jid, { text: 'Podrías decirnos _*¿Por qué esa calificación?*_' });
            }, 1000);
            // Sets the state as the first response has been handled
            conversationState.hasHandledFirstResponse = true;
            // Saves the state in the database
            await saveConversationState(phoneNumber, conversationState);
        } else {
            // In case is the second response updates the response in the database
            await saveResponse(phoneNumber, text, false);
            // Delays the message by 1 second and sends a thank you message
            setTimeout(async () => {
                await sock.sendMessage(jid, { text: '_*¡Muchas gracias por tu tiempo!*_' });
            }, 1000);
            // Removes it from the conversation state queue in the database
            await deleteConversationState(phoneNumber);
        }
    }
    // Otherwise ignore it and removes the phone number from the queue in the database
    else {
        await deleteConversationState(phoneNumber);
    }
}

// Async function to save the responses in the database
async function saveInitialResponse(phoneNumber, clientID, name, company, orderID, products) {
    await executeQuery(
        'INSERT INTO responses (phone_number, clientID, name, company, orderID, products) VALUES (?, ?, ?, ?, ?, ?) ',
        [phoneNumber, clientID, name, company, orderID, products]);
}

// Async function to update the responses in the database
async function saveResponse(phoneNumber, response, isFirstResponse) {
    // In case is the first response, proceeds to update the first_response field
    if (isFirstResponse) {
        const numericValue = await extractRating(response);
        await executeQuery(
            'UPDATE responses SET first_response = ?, first_response_value = ? WHERE id = (' +
            'SELECT id FROM (' +
            'SELECT id FROM responses WHERE phone_number = ? ORDER BY id DESC LIMIT 1' +
            ') AS subquery)', [response, numericValue, phoneNumber]);
    }
    // Else, is the second response, proceeds to update the second_response field
    else {
        await executeQuery(
            'UPDATE responses SET second_response = ? WHERE id = (' +
            'SELECT id FROM (' +
            'SELECT id FROM responses WHERE phone_number = ? ORDER BY id DESC LIMIT 1' +
            ') AS subquery)', [response, phoneNumber]);
    }
}

// Async function to extract the rating
async function extractRating(text) {
    // REGEX pattern to match numbers between 1 and 5
    const ratingPattern = /[1-5]/;
    // REGEX pattern to match literal representations of numbers
    const literalRatingPattern = /uno|dos|tres|cuatro|cinco/gi;
    // Function to calculate Levenshtein distance between two strings
    function levenshteinDistance(a, b) {
        const m = a.length, n = b.length;
        const dp = Array.from(Array(m + 1), () => Array(n + 1).fill(0));
        for (let i = 0; i <= m; i++) {
            for (let j = 0; j <= n; j++) {
                if (i === 0) dp[i][j] = j;
                else if (j === 0) dp[i][j] = i;
                else if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1];
                else dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
            }
        }
        return dp[m][n];
    }
    // Search for numerical rating in the text
    let match = text.match(ratingPattern);
    // If a numerical rating is found, return it
    if (match) {
        return parseInt(match[0]);
    }
    // If no numerical rating is found, search for literal representations
    match = text.match(literalRatingPattern);
    // If a literal rating is found, map it to the corresponding number
    if (match) {
        const literalToNumber = {
            'uno': 1,
            'dos': 2,
            'tres': 3,
            'cuatro': 4,
            'cinco': 5
        };
        const literalRating = match[0].toLowerCase();
        return literalToNumber[literalRating];
    }
    // If no rating is found, attempt to correct misspellings in each word
    const possibleRatings = ['uno', 'dos', 'tres', 'cuatro', 'cinco'];
    const words = text.toLowerCase().split(/\s+/);
    let minDistance = Infinity;
    let closestRating = null;
    for (let word of words) {
        // Not considering the common words in a phrase like un, doy, no or es because they are unlikely to be part of a rating
        if (word != "un" && word != "doy" && word != "no" && word != "es" && word.length < 9){
            for (const rating of possibleRatings) {
                const distance = levenshteinDistance(word.toLowerCase(), rating);
                if (distance < minDistance) {
                    minDistance = distance;
                    closestRating = rating;
                }
            }
        }
    }
    // If the closest rating is within a certain threshold, return its numerical value
    if (minDistance <= 2) {
        return possibleRatings.indexOf(closestRating) + 1;
    }
    // If no rating is found or corrected, return a text that the numeric value was not found
    return "Ningun número encontrado";
}

// Async function that checks if the number was already contacted in the day
async function hasBeenContactedToday(phoneNumber)  {
    // Query the responses table and get the count of contacts for the given phone number on the current day
    const rows = await executeQuery('SELECT COUNT(*) FROM responses WHERE DATE(created_at)=CURDATE() AND phone_number=? ORDER BY id DESC LIMIT 1', ["591" + phoneNumber]);
    const count = rows[0]['COUNT(*)'];
    return count > 0 ? true : false;
}

// API endpoint to send the survey
app.post('/envioWhatsapp', async (req, res) => {
    // Getting in the body the ID, name and phone number of the client, the company name, the order ID and the products in the order
    const phoneNumber = req.body.celular;
    const clientID  = req.body.IDcliente;
    const name = req.body.nombreCliente;
    const company = req.body.empresa;
    const orderID = req.body.IDpedido;
    const products = req.body.productos;
    // Converting to WhatsApp phone number format
    const jid = '591' + phoneNumber + '@s.whatsapp.net';
    try {
        // Verifies if the number was already contacted
        const contactedToday = await hasBeenContactedToday(phoneNumber);
        // If was not contacted yet, then proceed to send the survey questions
        if (!contactedToday){
            // Sends the initial message and the first question of the survey
            await sock.sendMessage(jid, { text: 'Hola *'+ name +'*, gracias por tu compra en *'+ company +'*. \n\nEsperamos que tu pedido _#' + orderID + '_ que contiene los siguientes productos:\n\n' + '_' + products + '_' + '\n\nllegaron de manera efectiva.'});
            await sock.sendMessage(jid, { text: 'Su experiencia con la atención es muy importante para nosotros. \n\nEn una _*escala del 1 al 5*_ donde 1 significa que no nos recomendaría y 5 que nos recomendaría totalmente. \n\n_*¿Cuál sería su calificación?*_' });
            // Saves the response initial parameteres of the response in the database
            await saveInitialResponse('591' + phoneNumber, clientID, name, company, orderID, products);
            // Saves the conversation state in the database
            await saveConversationState('591' + phoneNumber, { hasHandledFirstResponse: false });
            // API response as message successfully sent
            console.log("Mensaje enviado correctamente a " + phoneNumber);
            res.send('Mensaje enviado correctamente');
        }
        // If is already contacted send the response that the client was already messaged
        else {
            // API response as message successfully sent
            console.log("Mensaje enviado anteriormente a " + phoneNumber);
            res.send('Mensaje enviado anteriormente');
        }
    } catch (error) {
        // Otherwise console the error and sends the error response
        console.error(error);
        res.status(500).send('Error en el envio de whatsapp');
    }
});

// The first time runs the server and initializes the WhatsApp connection or restores the saved connection
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    initializeWhatsAppConnection();
});
