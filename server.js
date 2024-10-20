const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sql = require('mssql');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const connectedUsers = new Map();

const dbConfig = {
    user: 'sa', // Reemplaza con tu nombre de usuario de SQL Server
    password: 'sas', // Reemplaza con tu contraseña de SQL Server
    server: 'localhost', // Reemplaza con el nombre o la IP de tu servidor
    database: 'ChatUniversitario', // Reemplaza con el nombre de tu base de datos
    options: {
        encrypt: true, // Usa esto si estás en Windows Azure
        trustServerCertificate: true // Cambia a false para producción
    }
};

sql.connect(dbConfig, (err) => {
    if (err) console.log(err);
    else console.log('Connected to database');
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
    secret: 'your_secret_key',
    resave: false,
    saveUninitialized: true
}));

app.use(express.static(path.join(__dirname, 'public')));

app.post('/login', async (req, res) => {
    const { correo, contrasena } = req.body;

    try {
        const pool = await sql.connect(dbConfig);
        const result = await pool.request()
            .input('correo', sql.NVarChar, correo)
            .query('SELECT * FROM usuarios WHERE correo = @correo');

        if (result.recordset.length === 0) {
            return res.status(404).send('No user found');
        }

        const user = result.recordset[0];
        const passwordIsValid = bcrypt.compareSync(contrasena, user.contrasena);
        if (!passwordIsValid) {
            return res.status(401).send('Invalid password');
        }

        req.session.userId = user.id;
        connectedUsers.set(user.id, { socketId: null }); // Marcar al usuario como conectado
        res.status(200).json({ userId: user.id });
    } catch (err) {
        res.status(500).send('Error on the server');
    }
});

app.post('/logout', (req, res) => {
    const userId = req.session.userId;
    connectedUsers.delete(userId); // Marcar al usuario como desconectado
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).send('Error logging out');
        }
        res.status(200).send('Logout successful');
    });
});

app.post('/register', async (req, res) => {
    const { nombre, correo, contrasena } = req.body;
    const hashedPassword = bcrypt.hashSync(contrasena, 8);

    try {
        const pool = await sql.connect(dbConfig);
        const result = await pool.request()
            .input('nombre', sql.NVarChar, nombre)
            .input('correo', sql.NVarChar, correo)
            .input('contrasena', sql.NVarChar, hashedPassword)
            .query('INSERT INTO usuarios (nombre, correo, contrasena) VALUES (@nombre, @correo, @contrasena)');
        res.status(200).send('User registered successfully');
    } catch (err) {
        res.status(500).send('Error registering user');
    }
});

app.get('/search-users', async (req, res) => {
    const { term } = req.query;

    try {
        const pool = await sql.connect(dbConfig);
        const result = await pool.request()
            .input('term', sql.NVarChar, `%${term}%`)
            .query('SELECT id, nombre, correo FROM usuarios WHERE nombre LIKE @term OR correo LIKE @term');

        res.status(200).json(result.recordset);
    } catch (err) {
        res.status(500).send('Error searching users');
    }
});

app.get('/user-status/:userId', (req, res) => {
    const userId = parseInt(req.params.userId, 10);
    const isActive = connectedUsers.has(userId);
    res.status(200).json({ isActive });
});

app.get('/messages/:userId1/:userId2', async (req, res) => {
    const { userId1, userId2 } = req.params;

    try {
        const pool = await sql.connect(dbConfig);
        const result = await pool.request()
            .input('userId1', sql.Int, userId1)
            .input('userId2', sql.Int, userId2)
            .query(`
                SELECT * FROM mensajes
                WHERE (remitente_id = @userId1 AND destinatario_id = @userId2)
                   OR (remitente_id = @userId2 AND destinatario_id = @userId1)
                ORDER BY fecha_envio ASC
            `);

        res.status(200).json(result.recordset);
    } catch (err) {
        res.status(500).send('Error fetching messages');
    }
});

io.on('connection', (socket) => {
    console.log('New user connected');

    socket.on('register user', (userId) => {
        if (connectedUsers.has(userId)) {
            connectedUsers.get(userId).socketId = socket.id;
        }
    });

    socket.on('private message', async ({ senderId, receiverId, message }) => {
        senderId = parseInt(senderId, 10);
        receiverId = parseInt(receiverId, 10);

        if (isNaN(senderId) || isNaN(receiverId)) {
            console.error('Invalid senderId or receiverId');
            return;
        }

        const pool = await sql.connect(dbConfig);
        await pool.request()
            .input('remitente_id', sql.Int, senderId)
            .input('destinatario_id', sql.Int, receiverId)
            .input('mensaje', sql.NVarChar, message)
            .query('INSERT INTO mensajes (remitente_id, destinatario_id, mensaje, fecha_envio) VALUES (@remitente_id, @destinatario_id, @mensaje, GETDATE())');

        if (connectedUsers.has(receiverId)) {
            const receiverSocketId = connectedUsers.get(receiverId).socketId;
            if (receiverSocketId) {
                socket.to(receiverSocketId).emit('private message', { senderId, message });
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
        connectedUsers.forEach((value, key) => {
            if (value.socketId === socket.id) {
                connectedUsers.delete(key);
            }
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});