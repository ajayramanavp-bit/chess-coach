const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
app.use(express.json());

const allowedOrigins = [
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  process.env.FRONTEND_URL
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));

const chessRoutes = require('./routes/chess');
app.use('/api', chessRoutes);

app.get('/', (req, res) => {
  res.json({ status: 'Chess Coach backend is running!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});