// REST API, MySQl, JSON parse and Baileys WhatsApp libraries
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
    database: process.env.DB_DATABASE
};

// API port
const app = express();
const port = 7000;

// JSON parse
app.use(bodyParser.json());

// Sock definition as Baileys WhatsApp connection
let sock;

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
        // In case number is from own number, do nothing
        if (message.key.fromMe) return;
        // Formatting the incoming WhatsApp number to WhatsApp JID
        const fromNumber = message.key.remoteJid.replace(/@s.whatsapp.net$/, '');
        // Retrieve conversation state from the database
        const conversationState = await getConversationState(fromNumber);
        if (conversationState) {
            // Handle the incoming message
            await handleIncomingMessage(conversationState, fromNumber, message);
        }
    });
}

// Async function to save the conversation state in the database
async function saveConversationState(phoneNumber, state) {
    const connection = await mysql.createConnection(dbConfig);
    try {
        // Only one state can be active at a time per number
        await connection.execute(
            'INSERT INTO conversation_states (phone_number, state) VALUES (?, ?) ' +
            'ON DUPLICATE KEY UPDATE state = VALUES(state)',
            [phoneNumber, JSON.stringify(state)]
        );
    } finally {
        await connection.end();
    }
}

// Async function to get conversation state from the database
async function getConversationState(phoneNumber) {
    const connection = await mysql.createConnection(dbConfig);
    try {
        const [rows] = await connection.execute(
            'SELECT state FROM conversation_states WHERE phone_number = ?',
            [phoneNumber]
        );
        if (rows.length > 0) {
            return JSON.parse(rows[0].state);
        }
        return null;
    } finally {
        await connection.end();
    }
}

// Async function to delete conversation state from the database
async function deleteConversationState(phoneNumber) {
    const connection = await mysql.createConnection(dbConfig);
    try {
        await connection.execute(
            'DELETE FROM conversation_states WHERE phone_number = ?',
            [phoneNumber]
        );
    } finally {
        await connection.end();
    }
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
                await sock.sendMessage(jid, { text: 'Podrías decirnos ¿Por qué esa calificación?' });
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
                await sock.sendMessage(jid, { text: '¡Muchas gracias por tu tiempo!' });
            }, 1000);
            // Removes it from the conversation state queue in the database
            await deleteConversationState(phoneNumber);
        }
    }
    // Otherwise ignore it and removes the phone number from the queue
    else {
        await deleteConversationState(phoneNumber);
    }
}

// Async function to save the responses in the database
async function saveResponse(phoneNumber, response, isFirstResponse) {
    // Stablishing the database connection
    const connection = await mysql.createConnection(dbConfig);
    // Tries to save the response in the database, at the end closes the connetion
    try {
        // In case is the first response, proceeds to save it
        if (isFirstResponse) {
            await connection.execute(
                'INSERT INTO responses (phone_number, first_response) VALUES (?, ?) ' +
                'ON DUPLICATE KEY UPDATE first_response = VALUES(first_response)',
                [phoneNumber, response]);
        }
        // Else, is the second response and updates the corresponding row
        else {
            await connection.execute(
                'UPDATE responses SET second_response = ? WHERE id = (' +
                'SELECT id FROM (' +
                'SELECT id FROM responses WHERE phone_number = ? ORDER BY id DESC LIMIT 1' +
                ') AS subquery)', [response, phoneNumber]);
        }
    } finally {
        await connection.end();
    }
}

// API endpoint to send the survey
app.post('/envioWhatsapp', async (req, res) => {
    // Getting in the body the phone number of client
    const phoneNumber = req.body.phoneNumber;
    // Converting to WhatsApp phone number format
    const jid = '591' + phoneNumber + '@s.whatsapp.net';
    try {
        // Sends the initial message and the first question of the survey
        await sock.sendMessage(jid, { text: 'Gracias, por tu compra! Puedes calificarla del 1 al 5.' });
        // Save conversation state in the database
        await saveConversationState('591' + phoneNumber, { hasHandledFirstResponse: false });
        // API response as message successfully sent
        res.send('Mensaje enviado correctamente');
    } catch (error) {
        // Otherwise console the error and response with error trying to send the message
        console.error(error);
        res.status(500).send('Error en el envio de whatsapp');
    }
});

// The first time runs the server, initialize the WhatsApp connection or restores the saved connection
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    initializeWhatsAppConnection();
});
