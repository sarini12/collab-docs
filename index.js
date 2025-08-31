import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { MongoClient, ObjectId } from 'mongodb';
import DiffMatchPatch from 'diff-match-patch';

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*' }
});

const dmp = new DiffMatchPatch();

// Use env var or fallback to local MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/collab_docs';
const PORT = process.env.PORT || 4000;

// ✅ FIX: tell client which database to use
const client = new MongoClient(MONGODB_URI, { useUnifiedTopology: true });
let Docs;

async function initDb() {
  await client.connect();
  // If dbName not included in URI, explicitly set it here
  const dbName = MONGODB_URI.split('/').pop() || 'collab_docs';
  const db = client.db(dbName);

  Docs = db.collection('documents');
  await Docs.createIndex({ key: 1 }, { unique: true });
  console.log('✅ MongoDB connected');
}
initDb().catch(console.error);

// REST helper: create or fetch document
app.get('/api/doc/:key', async (req, res) => {
  const { key } = req.params;
  let doc = await Docs.findOne({ key });
  if (!doc) {
    doc = { key, content: '', updatedAt: new Date() };
    await Docs.insertOne(doc);
  }
  res.json({ key: doc.key, content: doc.content });
});

app.post('/api/doc', async (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  let existing = await Docs.findOne({ key });
  if (existing) return res.json({ key, created: false });
  await Docs.insertOne({ key, content: '', updatedAt: new Date() });
  res.json({ key, created: true });
});

// Socket.IO real-time collaboration
io.on('connection', (socket) => {
  // client joins a document "room"
  socket.on('doc:join', async (key) => {
    socket.join(key);

    // send current content to the newly joined client
    const doc = await Docs.findOne({ key }) || { content: '' };
    socket.emit('doc:load', { content: doc.content });
  });

  // client sends patches generated from its local text
  socket.on('doc:patch', async ({ key, patches }) => {
    try {
      // fetch current server text
      let doc = await Docs.findOne({ key });
      if (!doc) {
        doc = { key, content: '', updatedAt: new Date() };
        await Docs.insertOne(doc);
      }

      // apply incoming patches to server text
      const patchObj = dmp.patch_fromText(patches);
      const [newText, results] = dmp.patch_apply(patchObj, doc.content);

      // save if changed
      if (newText !== doc.content) {
        await Docs.updateOne(
          { _id: doc._id },
          { $set: { content: newText, updatedAt: new Date() } }
        );

        // broadcast patches to everyone else in the room
        socket.to(key).emit('doc:patch', { patches });
      }
    } catch (err) {
      console.error(err);
      socket.emit('doc:error', 'Patch failed');
    }
  });
});

server.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));

