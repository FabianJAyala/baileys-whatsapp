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
const conversationStates = {};

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
        const message = m.messages[0];
        if (message.key.fromMe) return;
        const fromNumber = message.key.remoteJid.replace(/@s.whatsapp.net$/, '');
        if (conversationStates[fromNumber]) {
            await conversationStates[fromNumber](message);
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
                'UPDATE responses SET second_response = ? WHERE id = (' +
                'SELECT id FROM (' +
                'SELECT id FROM responses WHERE phone_number = ? ORDER BY id DESC LIMIT 1' +
                ') AS subquery)', [response, phoneNumber]);
        }
    } finally {
        await connection.end();
    }
}

app.post('/envioWhatsapp', async (req, res) => {
    const phoneNumber = req.body.phoneNumber;
    const jid = '591' + phoneNumber + '@s.whatsapp.net';
    try {
        await sock.sendMessage(jid, { text: 'Gracias, por tu compra! Puedes calificarla del 1 al 5.' });
        conversationStates['591' + phoneNumber] = async (message) => {
            const text = message.message.conversation || message.message.extendedTextMessage?.text;
            if (!!text){
                if (!conversationStates['591' + phoneNumber].hasHandledFirstResponse) {
                    await saveResponse(phoneNumber, text, true);
                    setTimeout(async () => {
                        await sock.sendMessage(jid, { text: 'Podrías decirnos ¿Por qué esa calificación?' });
                    }, 1000);
                    conversationStates['591' + phoneNumber].hasHandledFirstResponse = true;
                } else {
                    await saveResponse(phoneNumber, text, false);
                    setTimeout(async () => {
                        await sock.sendMessage(jid, { text: '¡Muchas gracias por tu tiempo!' });
                    }, 1000);
                    delete conversationStates['591' + phoneNumber];
                }
            }
            else {
                delete conversationStates['591' + phoneNumber];
            }
        };
        conversationStates['591' + phoneNumber].hasHandledFirstResponse = false;
        res.send('Mensaje enviado correctamente');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error en el envio de whatsapp');
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    initializeWhatsAppConnection();
});
