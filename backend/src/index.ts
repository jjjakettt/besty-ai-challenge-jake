import dotenv from 'dotenv';
dotenv.config();

console.log('Backend starting...');
console.log('DB:', process.env.DATABASE_URL);
console.log('Port:', process.env.PORT);
