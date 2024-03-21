const express = require('express');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const { useMultiFileAuthState, makeWASocket, DisconnectReason } = require("@whiskeysockets/baileys");

const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'satisfaccion_cliente'
};

const app = express();
const port = 7000;

app.use(bodyParser.json());

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
                'UPDATE responses SET second_response = ? WHERE id = (' +
                'SELECT id FROM (' +
                'SELECT id FROM responses WHERE phone_number = ? ORDER BY id DESC LIMIT 1' +
                ') AS subquery)', [response, phoneNumber]);
        }
    } finally {
        await connection.end();
    }
}

app.post('/sendWhatsAppMessage', async (req, res) => {
    const phoneNumber = req.body.phoneNumber;
    if (!phoneNumber) {
        return res.status(400).send('Phone number is required');
    }
    try {
        await connectToWhatsApp(phoneNumber);
        res.send('WhatsApp message is being sent');
    } catch (error) {
        res.status(500).send('Failed to send WhatsApp message');
    }
});

async function connectToWhatsApp(phoneNumber) {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");

    const sock = makeWASocket({
        printQRInTerminal: true,
        auth: state,
    });

    let responseStage = 0;

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update || {};

        if (qr) {
            console.log(qr);
        }

        /*if (connection === "close") {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        }*/
    });

    sock.ev.on("messages.upsert", async (m) => {
        const message = m.messages[0];
        if (message.key.fromMe || !message.message) return;

        const from = message.key.remoteJid;
        const text = message.message.conversation || message.message.extendedTextMessage?.text;

        if (from && responseStage <= 2) {
            if (responseStage === 0) {
                await saveResponse(phoneNumber, text, true);
                responseStage = 1;

                setTimeout(async () => {
                    await sock.sendMessage(from, { text: 'Podrías decirnos ¿Por qué esa calificación?' });
                }, 1000);

            } else if (responseStage === 1) {
                await saveResponse(phoneNumber, text, false);
                responseStage = 2;

                setTimeout(async () => {
                    await sock.sendMessage(from, { text: '¡Muchas gracias por tu tiempo!' });
                }, 1000);
                setTimeout(() => {
                    sock.end(new Error("Completed interaction sequence"));
                }, 2000);
            }
        }
    });

    sock.ev.on("creds.update", saveCreds);

    setTimeout(async () => {
        const jid = '591' + phoneNumber + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: 'Gracias, por tu compra! Puedes calificarla del 1 al 5.' });
        responseStage = 0;
    }, 30000);
}

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});