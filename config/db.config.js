// ดึงค่าจากไฟล์ .env
require('dotenv').config();

const mysql = require('mysql2');

// สร้าง Pool Connection เพื่อประสิทธิภาพที่ดีขึ้น
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  port: process.env.DB_PORT,
  waitForConnections: true,
  connectionLimit: 10, // กำหนดจำนวน Connection สูงสุด
  queueLimit: 0
});

// ส่งออก pool ที่สามารถใช้งานได้
module.exports = pool.promise(); // ใช้ pool.promise() เพื่อให้ใช้ async/await ได้