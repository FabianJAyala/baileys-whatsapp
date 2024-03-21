const express = require('express');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const { useMultiFileAuthState, makeWASocket } = require("@whiskeysockets/baileys");

const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'satisfaccion_cliente'
};

const app = express();
const port = 7000;

app.use(bodyParser.json());

let sock;
const messageHandlers = new Map();

async function initializeWhatsAppConnection() {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
    sock = makeWASocket({
        printQRInTerminal: true,
        auth: state,
    });

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (update) => {
        if (update.connection === "close") {
            initializeWhatsAppConnection();
        }
    });

    sock.ev.on("messages.upsert", async (m) => {
        console.log("Message received:", m);
        const message = m.messages[0];
        if (message.key.fromMe) return;
        const fromNumber = message.key.remoteJid.replace(/@s.whatsapp.net$/, '');
        console.log("Processed fromNumber for handler lookup:", fromNumber);
        const handler = messageHandlers.get(fromNumber);
        if (handler) {
            console.log("Handler found, processing message.");
            handler(message);
        } else {
            console.log("No handler registered for this number:", fromNumber);
        }
    });
}

async function saveResponse(phoneNumber, response, isFirstResponse) {
    const connection = await mysql.createConnection(dbConfig);
    try {
        if (isFirstResponse) {
            await connection.execute(
                'INSERT INTO responses (phone_number, first_response) VALUES (?, ?) ' +
                'ON DUPLICATE KEY UPDATE first_response = VALUES(first_response)',
                [phoneNumber, response]);
        } else {
            await connection.execute(
                'UPDATE responses SET second_response = ? WHERE phone_number = ?', [response, phoneNumber]);
        }
    } finally {
        await connection.end();
    }
}

function registerMessageHandler(phoneNumber, handler) {
    messageHandlers.set(phoneNumber, handler);
}

function unregisterMessageHandler(phoneNumber) {
    messageHandlers.delete(phoneNumber);
}

app.post('/startFeedback', async (req, res) => {
    const phoneNumber = req.body.phoneNumber;
    const jid = '591' + phoneNumber + '@s.whatsapp.net';
    try {
        await sock.sendMessage(jid, { text: 'Gracias, por tu compra! Puedes calificarla del 1 al 5.' });
        registerMessageHandler('591' + phoneNumber, async (message) => {
            const text = message.message.conversation || message.message.extendedTextMessage?.text;
            await saveResponse(phoneNumber, text, true);
            await sock.sendMessage(jid, { text: 'Podrías decirnos ¿Por qué esa calificación?' });
            await saveResponse(phoneNumber, text, false);
            await sock.sendMessage(jid, { text: '¡Muchas gracias por tu tiempo!' });
            unregisterMessageHandler('591' + phoneNumber);
        });
        res.send('Feedback process started');
    } catch (error) {
        res.status(500).send('Failed to start the feedback process');
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    initializeWhatsAppConnection();
});
