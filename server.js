require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const path = require('path');
const cors = require('cors');
const WebSocket = require('ws');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const fs = require('fs').promises;

const app = express();
const port = process.env.PORT || 3000;

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ตรวจสอบ Cloudinary configuration
if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  console.error('Cloudinary configuration missing. Please check .env file.');
  process.exit(1);
}

// Multer configuration
const tempStorage = multer({ dest: 'uploads/' });

// Database configuration
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 50,
});

// Test DB connection
db.getConnection()
  .then(() => console.log('Connected to MySQL database'))
  .catch(err => {
    console.error('DB connection error:', err);
    process.exit(1);
  });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// WebSocket server
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${port}`);
  console.log(`WebSocket server running at ws://0.0.0.0:${port}/ws`);
});
const wss = new WebSocket.Server({ server });
const clients = new Map();

wss.on('connection', (ws, req) => {
  const riderId = req.url.split('/ws/')[1] || req.url.split('/').pop();
  console.log(`WebSocket connected for riderId: ${riderId}`);

  if (!clients.has(riderId)) {
    clients.set(riderId, new Set());
  }
  clients.get(riderId).add(ws);

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      const { latitude, longitude } = data;
      if (latitude && longitude) {
        await db.query(
          'INSERT INTO rider_locations (rider_id, latitude, longitude) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE latitude = ?, longitude = ?, updated_at = CURRENT_TIMESTAMP',
          [riderId, latitude, longitude, latitude, longitude]
        );
        console.log(`Updated location for rider ${riderId}: ${latitude}, ${longitude}`);
      }
    } catch (err) {
      console.error('WebSocket message error:', err);
    }
  });

  ws.on('close', () => {
    console.log(`WebSocket disconnected for riderId: ${riderId}`);
    clients.get(riderId)?.delete(ws);
    if (clients.get(riderId)?.size === 0) {
      clients.delete(riderId);
    }
  });
});

// Convert Cloudinary public_id to URL
const toFileUrl = (publicId) => {
  if (!publicId) return '';
  return cloudinary.url(publicId, {
    secure: true,
    transformation: [
      { width: 400, height: 300, crop: 'fill' },
      { quality: 'auto', fetch_format: 'auto' },
    ],
  });
};

// Multer error handling
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    console.error('Multer error:', err);
    return res.status(400).json({ message: 'ข้อผิดพลาดในการอัปโหลดไฟล์', error: err.message });
  } else if (err) {
    console.error('Unknown upload error:', err);
    return res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์', error: err.message });
  }
  next();
};

app.use('/register', handleMulterError);
app.use('/create-order', handleMulterError);
app.use('/upload-pickup-image', handleMulterError);
app.use('/upload-delivery-image', handleMulterError);
app.use('/upload-order-image', handleMulterError);

// Health check
app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.status(200).json({ status: 'OK', database: 'connected' });
  } catch (err) {
    console.error('Health check failed:', err);
    res.status(500).json({ status: 'ERROR', error: err.message });
  }
});

// Login
app.post('/login', async (req, res) => {
  const stopwatch = Stopwatch();
  try {
    const { phone, password, role } = req.body;
    if (!phone || !password || role === undefined) {
      return res.status(400).json({ message: 'กรุณากรอกเบอร์โทรศัพท์ รหัสผ่าน และบทบาท' });
    }

    const [users] = await db.query('SELECT id, password, role, name FROM users WHERE phone = ? AND role = ?', [phone, role]);
    if (users.length === 0) {
      return res.status(401).json({ message: 'เบอร์โทรศัพท์หรือบทบาทไม่ถูกต้อง' });
    }

    const user = users[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'รหัสผ่านไม่ถูกต้อง' });
    }

    res.status(200).json({
      message: 'เข้าสู่ระบบสำเร็จ',
      userId: user.id,
      phone,
      role,
      name: user.name,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์', error: err.message });
  } finally {
    console.log('Login response time:', stopwatch.elapsedMilliseconds, 'ms');
  }
});

// Register
app.post('/register', tempStorage.fields([{ name: 'profileImage' }, { name: 'vehicleImage' }]), async (req, res) => {
  const stopwatch = Stopwatch();
  try {
    const { phone, password, name, role, vehicle_reg, addresses } = req.body;
    const roleInt = parseInt(role);
    let profileUrl = null;
    let vehicleUrl = null;

    if (req.files?.profileImage?.[0]) {
      const profileResult = await cloudinary.uploader.upload(req.files.profileImage[0].path, {
        folder: 'mobile_final',
        allowed_formats: ['jpg', 'png', 'jpeg'],
        transformation: [{ width: 500, height: 500, crop: 'limit' }, { quality: 'auto', fetch_format: 'auto' }],
      });
      profileUrl = profileResult.secure_url;
      await fs.unlink(req.files.profileImage[0].path);
    }

    if (req.files?.vehicleImage?.[0]) {
      const vehicleResult = await cloudinary.uploader.upload(req.files.vehicleImage[0].path, {
        folder: 'mobile_final',
        allowed_formats: ['jpg', 'png', 'jpeg'],
        transformation: [{ width: 500, height: 500, crop: 'limit' }, { quality: 'auto', fetch_format: 'auto' }],
      });
      vehicleUrl = vehicleResult.secure_url;
      await fs.unlink(req.files.vehicleImage[0].path);
    }

    const [existingUsers] = await db.query('SELECT id FROM users WHERE phone = ?', [phone]);
    if (existingUsers.length > 0) {
      return res.status(400).json({ message: 'เบอร์โทรศัพท์นี้ถูกใช้แล้ว' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const [userResult] = await db.query(
      'INSERT INTO users (phone, password, name, role, profile_image_url, vehicle_reg, vehicle_image_url) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [phone, hashed, name, roleInt, profileUrl, roleInt === 1 ? vehicle_reg : null, roleInt === 1 ? vehicleUrl : null]
    );

    if (roleInt === 0 && addresses) {
      const addrArray = JSON.parse(addresses).map(a => [
        userResult.insertId,
        a.addressName,
        a.addressDetail,
        a.lat,
        a.lng,
      ]);
      await db.query('INSERT INTO user_addresses (user_id, address_name, address_detail, latitude, longitude) VALUES ?', [addrArray]);
    }

    res.status(200).json({ userId: userResult.insertId, profileUrl, vehicleUrl });
  } catch (err) {
    console.error('Register error:', err);
    if (req.files?.profileImage?.[0]) await fs.unlink(req.files.profileImage[0].path).catch(() => {});
    if (req.files?.vehicleImage?.[0]) await fs.unlink(req.files.vehicleImage[0].path).catch(() => {});
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์', error: err.message });
  } finally {
    console.log('Register response time:', stopwatch.elapsedMilliseconds, 'ms');
  }
});

// Get addresses
app.get('/get-addresses/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const [addresses] = await db.query('SELECT * FROM user_addresses WHERE user_id = ?', [userId]);
    res.status(200).json(addresses);
  } catch (err) {
    console.error('Get addresses error:', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์', error: err.message });
  }
});

// Update order status
app.post('/update-order-status', async (req, res) => {
  const stopwatch = Stopwatch();
  try {
    const { orderId, status } = req.body;
    const [result] = await db.query('UPDATE orders SET status = ? WHERE id = ? AND rider_id IS NOT NULL', [status, orderId]);
    if (result.affectedRows === 0) {
      return res.status(400).json({ message: 'ออเดอร์ไม่พบหรือไม่ถูกมอบหมายให้ไรเดอร์' });
    }

    const [updatedOrder] = await db.query(
      `SELECT o.*, 
              sa.id AS senderAddressId, sa.address_name AS senderAddressName, sa.address_detail AS senderAddressDetail, sa.latitude AS senderLat, sa.longitude AS senderLng,
              ra.id AS receiverAddressId, ra.address_name AS receiverAddressName, ra.address_detail AS receiverAddressDetail, ra.latitude AS receiverLat, ra.longitude AS receiverLng,
              r.name AS receiverName, r.phone AS receiverPhone
       FROM orders o
       JOIN user_addresses sa ON o.sender_address_id = sa.id
       JOIN user_addresses ra ON o.receiver_address_id = ra.id
       JOIN users r ON o.receiver_id = r.id
       WHERE o.id = ?`,
      [orderId]
    );

    if (updatedOrder.length === 0) {
      return res.status(400).json({ message: 'ออเดอร์ไม่พบ' });
    }

    const order = updatedOrder[0];
    order.senderAddress = {
      id: order.senderAddressId,
      address_name: order.senderAddressName || 'ไม่ระบุ',
      address_detail: order.senderAddressDetail || 'ไม่มีข้อมูล',
      latitude: parseFloat(order.senderLat) || 0.0,
      longitude: parseFloat(order.senderLng) || 0.0,
    };
    order.receiverAddress = {
      id: order.receiverAddressId,
      address_name: order.receiverAddressName || 'ไม่ระบุ',
      address_detail: order.receiverAddressDetail || 'ไม่มีข้อมูล',
      latitude: parseFloat(order.receiverLat) || 0.0,
      longitude: parseFloat(order.receiverLng) || 0.0,
    };
    order.product_image_url = toFileUrl(order.product_image_url) || '';
    order.pickup_image_url = toFileUrl(order.pickup_image_url) || '';
    order.delivery_image_url = toFileUrl(order.delivery_image_url) || '';

    res.status(200).json(order);
  } catch (err) {
    console.error('Update order status error:', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์', error: err.message });
  } finally {
    console.log('Update order status response time:', stopwatch.elapsedMilliseconds, 'ms');
  }
});

// Upload pickup image
app.post('/upload-pickup-image', tempStorage.single('productImage'), async (req, res) => {
  const stopwatch = Stopwatch();
  try {
    const { orderId, riderId } = req.body;
    if (!req.file) {
      return res.status(400).json({ message: 'ไม่มีรูปภาพจุดรับ' });
    }

    const filePath = req.file.path;
    const result = await cloudinary.uploader.upload(filePath, {
      folder: 'mobile_final',
      allowed_formats: ['jpg', 'png', 'jpeg'],
      transformation: [{ width: 500, height: 500, crop: 'limit' }, { quality: 'auto', fetch_format: 'auto' }],
    });
    const fileUrl = result.secure_url;
    await fs.unlink(filePath);

    const [resultUpdate] = await db.query(
      'UPDATE orders SET pickup_image_url = ?, status = 3 WHERE id = ? AND rider_id = ? AND status = 2',
      [fileUrl, orderId, riderId]
    );

    if (resultUpdate.affectedRows === 0) {
      return res.status(400).json({ message: 'ออเดอร์ไม่พบ, ไม่ถูกมอบหมายให้ไรเดอร์, หรือสถานะไม่ถูกต้อง' });
    }

    const [updatedOrder] = await db.query(
      `SELECT o.*, 
              sa.id AS senderAddressId, sa.address_name AS senderAddressName, sa.address_detail AS senderAddressDetail, sa.latitude AS senderLat, sa.longitude AS senderLng,
              ra.id AS receiverAddressId, ra.address_name AS receiverAddressName, ra.address_detail AS receiverAddressDetail, ra.latitude AS receiverLat, ra.longitude AS receiverLng,
              r.name AS receiverName, r.phone AS receiverPhone
       FROM orders o
       JOIN user_addresses sa ON o.sender_address_id = sa.id
       JOIN user_addresses ra ON o.receiver_address_id = ra.id
       JOIN users r ON o.receiver_id = r.id
       WHERE o.id = ?`,
      [orderId]
    );

    if (updatedOrder.length === 0) {
      return res.status(400).json({ message: 'ออเดอร์ไม่พบ' });
    }

    const order = updatedOrder[0];
    order.senderAddress = {
      id: order.senderAddressId,
      address_name: order.senderAddressName || 'ไม่ระบุ',
      address_detail: order.senderAddressDetail || 'ไม่มีข้อมูล',
      latitude: parseFloat(order.senderLat) || 0.0,
      longitude: parseFloat(order.senderLng) || 0.0,
    };
    order.receiverAddress = {
      id: order.receiverAddressId,
      address_name: order.receiverAddressName || 'ไม่ระบุ',
      address_detail: order.receiverAddressDetail || 'ไม่มีข้อมูล',
      latitude: parseFloat(order.receiverLat) || 0.0,
      longitude: parseFloat(order.receiverLng) || 0.0,
    };
    order.product_image_url = toFileUrl(order.product_image_url) || '';
    order.pickup_image_url = toFileUrl(order.pickup_image_url) || '';
    order.delivery_image_url = toFileUrl(order.delivery_image_url) || '';

    res.status(200).json(order);
  } catch (err) {
    console.error('Upload pickup image error:', err);
    if (req.file) await fs.unlink(req.file.path).catch(() => {});
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์', error: err.message });
  } finally {
    console.log('Upload pickup image response time:', stopwatch.elapsedMilliseconds, 'ms');
  }
});

// Upload delivery image
app.post('/upload-delivery-image', tempStorage.single('productImage'), async (req, res) => {
  const stopwatch = Stopwatch();
  try {
    const { orderId, riderId } = req.body;
    if (!req.file) {
      return res.status(400).json({ message: 'ไม่มีรูปภาพจุดส่ง' });
    }

    const filePath = req.file.path;
    const result = await cloudinary.uploader.upload(filePath, {
      folder: 'mobile_final',
      allowed_formats: ['jpg', 'png', 'jpeg'],
      transformation: [{ width: 500, height: 500, crop: 'limit' }, { quality: 'auto', fetch_format: 'auto' }],
    });
    const fileUrl = result.secure_url;
    await fs.unlink(filePath);

    const [resultUpdate] = await db.query(
      'UPDATE orders SET delivery_image_url = ?, status = 4 WHERE id = ? AND rider_id = ? AND status = 3',
      [fileUrl, orderId, riderId]
    );

    if (resultUpdate.affectedRows === 0) {
      return res.status(400).json({ message: 'ออเดอร์ไม่พบ, ไม่ถูกมอบหมายให้ไรเดอร์, หรือสถานะไม่ถูกต้อง' });
    }

    const [updatedOrder] = await db.query(
      `SELECT o.*, 
              sa.id AS senderAddressId, sa.address_name AS senderAddressName, sa.address_detail AS senderAddressDetail, sa.latitude AS senderLat, sa.longitude AS senderLng,
              ra.id AS receiverAddressId, ra.address_name AS receiverAddressName, ra.address_detail AS receiverAddressDetail, ra.latitude AS receiverLat, ra.longitude AS receiverLng,
              r.name AS receiverName, r.phone AS receiverPhone
       FROM orders o
       JOIN user_addresses sa ON o.sender_address_id = sa.id
       JOIN user_addresses ra ON o.receiver_address_id = ra.id
       JOIN users r ON o.receiver_id = r.id
       WHERE o.id = ?`,
      [orderId]
    );

    if (updatedOrder.length === 0) {
      return res.status(400).json({ message: 'ออเดอร์ไม่พบ' });
    }

    const order = updatedOrder[0];
    order.senderAddress = {
      id: order.senderAddressId,
      address_name: order.senderAddressName || 'ไม่ระบุ',
      address_detail: order.senderAddressDetail || 'ไม่มีข้อมูล',
      latitude: parseFloat(order.senderLat) || 0.0,
      longitude: parseFloat(order.senderLng) || 0.0,
    };
    order.receiverAddress = {
      id: order.receiverAddressId,
      address_name: order.receiverAddressName || 'ไม่ระบุ',
      address_detail: order.receiverAddressDetail || 'ไม่มีข้อมูล',
      latitude: parseFloat(order.receiverLat) || 0.0,
      longitude: parseFloat(order.receiverLng) || 0.0,
    };
    order.product_image_url = toFileUrl(order.product_image_url) || '';
    order.pickup_image_url = toFileUrl(order.pickup_image_url) || '';
    order.delivery_image_url = toFileUrl(order.delivery_image_url) || '';

    res.status(200).json(order);
  } catch (err) {
    console.error('Upload delivery image error:', err);
    if (req.file) await fs.unlink(req.file.path).catch(() => {});
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์', error: err.message });
  } finally {
    console.log('Upload delivery image response time:', stopwatch.elapsedMilliseconds, 'ms');
  }
});

// Get orders by sender
app.get('/get-orders/sender/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const [rows] = await db.query(
      `SELECT o.*, 
              sa.id AS senderAddressId, sa.address_name AS senderAddressName, sa.address_detail AS senderAddressDetail, sa.latitude AS senderLat, sa.longitude AS senderLng,
              ra.id AS receiverAddressId, ra.address_name AS receiverAddressName, ra.address_detail AS receiverAddressDetail, ra.latitude AS receiverLat, ra.longitude AS receiverLng,
              r.name AS receiverName, r.phone AS receiverPhone
       FROM orders o
       JOIN user_addresses sa ON o.sender_address_id = sa.id
       JOIN user_addresses ra ON o.receiver_address_id = ra.id
       JOIN users r ON o.receiver_id = r.id
       WHERE o.sender_id = ?`,
      [userId]
    );

    const formattedRows = rows.map(row => ({
      ...row,
      senderAddress: {
        id: row.senderAddressId,
        address_name: row.senderAddressName || 'ไม่ระบุ',
        address_detail: row.senderAddressDetail || 'ไม่มีข้อมูล',
        latitude: parseFloat(row.senderLat) || 0.0,
        longitude: parseFloat(row.senderLng) || 0.0,
      },
      receiverAddress: {
        id: row.receiverAddressId,
        address_name: row.receiverAddressName || 'ไม่ระบุ',
        address_detail: row.receiverAddressDetail || 'ไม่มีข้อมูล',
        latitude: parseFloat(row.receiverLat) || 0.0,
        longitude: parseFloat(row.receiverLng) || 0.0,
      },
      product_image_url: toFileUrl(row.product_image_url) || '',
      pickup_image_url: toFileUrl(row.pickup_image_url) || '',
      delivery_image_url: toFileUrl(row.delivery_image_url) || '',
    }));

    res.status(200).json(formattedRows);
  } catch (err) {
    console.error('Get sender orders error:', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์', error: err.message });
  }
});

// Get orders by receiver
app.get('/get-orders/receiver/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const [rows] = await db.query(
      `SELECT o.*, 
              sa.id AS senderAddressId, sa.address_name AS senderAddressName, sa.address_detail AS senderAddressDetail, sa.latitude AS senderLat, sa.longitude AS senderLng,
              ra.id AS receiverAddressId, ra.address_name AS receiverAddressName, ra.address_detail AS receiverAddressDetail, ra.latitude AS receiverLat, ra.longitude AS receiverLng,
              r.name AS receiverName, r.phone AS receiverPhone
       FROM orders o
       JOIN user_addresses sa ON o.sender_address_id = sa.id
       JOIN user_addresses ra ON o.receiver_address_id = ra.id
       JOIN users r ON o.receiver_id = r.id
       WHERE o.receiver_id = ?`,
      [userId]
    );

    const formattedRows = rows.map(row => ({
      ...row,
      senderAddress: {
        id: row.senderAddressId,
        address_name: row.senderAddressName || 'ไม่ระบุ',
        address_detail: row.senderAddressDetail || 'ไม่มีข้อมูล',
        latitude: parseFloat(row.senderLat) || 0.0,
        longitude: parseFloat(row.senderLng) || 0.0,
      },
      receiverAddress: {
        id: row.receiverAddressId,
        address_name: row.receiverAddressName || 'ไม่ระบุ',
        address_detail: row.receiverAddressDetail || 'ไม่มีข้อมูล',
        latitude: parseFloat(row.receiverLat) || 0.0,
        longitude: parseFloat(row.receiverLng) || 0.0,
      },
      product_image_url: toFileUrl(row.product_image_url) || '',
      pickup_image_url: toFileUrl(row.pickup_image_url) || '',
      delivery_image_url: toFileUrl(row.delivery_image_url) || '',
    }));

    res.status(200).json(formattedRows);
  } catch (err) {
    console.error('Get receiver orders error:', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์', error: err.message });
  }
});

// Get available orders
app.get('/get-orders/available', async (req, res) => {
  const stopwatch = Stopwatch();
  try {
    const [rows] = await db.query(
      `SELECT o.*, 
              sa.id AS senderAddressId, sa.address_name AS senderAddressName, sa.address_detail AS senderAddressDetail, sa.latitude AS senderLat, sa.longitude AS senderLng,
              ra.id AS receiverAddressId, ra.address_name AS receiverAddressName, ra.address_detail AS receiverAddressDetail, ra.latitude AS receiverLat, ra.longitude AS receiverLng,
              r.name AS receiverName, r.phone AS receiverPhone,
              DATE_FORMAT(o.created_at, '%Y-%m-%d %H:%i:%s') AS created_at_formatted,
              DATE_FORMAT(o.updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at_formatted
       FROM orders o
       JOIN user_addresses sa ON o.sender_address_id = sa.id
       JOIN user_addresses ra ON o.receiver_address_id = ra.id
       JOIN users r ON o.receiver_id = r.id
       WHERE o.status = 1 AND o.rider_id IS NULL`
    );

    const formattedRows = rows.map(row => ({
      id: row.id,
      receiverName: row.receiverName || 'ไม่ระบุชื่อ',
      receiverPhone: row.receiverPhone || '',
      product_details: row.product_details || '',
      product_image_url: toFileUrl(row.product_image_url) || '',
      status: row.status,
      created_at: row.created_at_formatted,
      updated_at: row.updated_at_formatted,
      senderAddress: {
        id: row.senderAddressId,
        address_name: row.senderAddressName || 'ไม่ระบุ',
        address_detail: row.senderAddressDetail || 'ไม่มีข้อมูล',
        latitude: parseFloat(row.senderLat) || 0.0,
        longitude: parseFloat(row.senderLng) || 0.0,
      },
      receiverAddress: {
        id: row.receiverAddressId,
        address_name: row.receiverAddressName || 'ไม่ระบุ',
        address_detail: row.receiverAddressDetail || 'ไม่มีข้อมูล',
        latitude: parseFloat(row.receiverLat) || 0.0,
        longitude: parseFloat(row.receiverLng) || 0.0,
      },
    }));

    res.status(200).json(formattedRows);
  } catch (err) {
    console.error('Get available orders error:', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์', error: err.message });
  } finally {
    console.log('Get available orders response time:', stopwatch.elapsedMilliseconds, 'ms');
  }
});

// Get rider orders
app.get('/get-orders-rider/:riderId', async (req, res) => {
  const stopwatch = Stopwatch();
  try {
    const { riderId } = req.params;
    const [rows] = await db.query(
      `SELECT o.*, 
              sa.id AS senderAddressId, sa.address_name AS senderAddressName, sa.address_detail AS senderAddressDetail, sa.latitude AS senderLat, sa.longitude AS senderLng,
              ra.id AS receiverAddressId, ra.address_name AS receiverAddressName, ra.address_detail AS receiverAddressDetail, ra.latitude AS receiverLat, ra.longitude AS receiverLng,
              r.name AS receiverName, r.phone AS receiverPhone
       FROM orders o
       JOIN user_addresses sa ON o.sender_address_id = sa.id
       JOIN user_addresses ra ON o.receiver_address_id = ra.id
       JOIN users r ON o.receiver_id = r.id
       WHERE o.rider_id = ? AND o.status IN (1, 2, 3, 4)
       ORDER BY o.created_at DESC`,
      [riderId]
    );

    const formattedRows = rows.map(row => ({
      ...row,
      senderAddress: {
        id: row.senderAddressId,
        address_name: row.senderAddressName || 'ไม่ระบุ',
        address_detail: row.senderAddressDetail || 'ไม่มีข้อมูล',
        latitude: parseFloat(row.senderLat) || 0.0,
        longitude: parseFloat(row.senderLng) || 0.0,
      },
      receiverAddress: {
        id: row.receiverAddressId,
        address_name: row.receiverAddressName || 'ไม่ระบุ',
        address_detail: row.receiverAddressDetail || 'ไม่มีข้อมูล',
        latitude: parseFloat(row.receiverLat) || 0.0,
        longitude: parseFloat(row.receiverLng) || 0.0,
      },
      product_image_url: toFileUrl(row.product_image_url) || '',
      pickup_image_url: toFileUrl(row.pickup_image_url) || '',
      delivery_image_url: toFileUrl(row.delivery_image_url) || '',
    }));

    res.status(200).json(formattedRows);
  } catch (err) {
    console.error('Get rider orders error:', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์', error: err.message });
  } finally {
    console.log('Get rider orders response time:', stopwatch.elapsedMilliseconds, 'ms');
  }
});

// Accept order
app.post('/accept-order', async (req, res) => {
  const stopwatch = Stopwatch();
  let connection;
  try {
    const { orderId, riderId } = req.body;
    if (!orderId || !riderId) {
      return res.status(400).json({ message: 'ต้องระบุ orderId และ riderId' });
    }

    connection = await db.getConnection();
    await connection.beginTransaction();

    const [activeOrders] = await connection.query(
      'SELECT id FROM orders WHERE rider_id = ? AND status IN (2, 3)',
      [riderId]
    );
    if (activeOrders.length > 0) {
      await connection.rollback();
      return res.status(400).json({ 
        message: 'คุณมีงานที่กำลังดำเนินการอยู่ กรุณาเสร็จสิ้นงานก่อนรับงานใหม่' 
      });
    }

    const [rows] = await connection.query(
      'SELECT * FROM orders WHERE id = ? AND status = 1 AND rider_id IS NULL',
      [orderId]
    );
    if (rows.length === 0) {
      await connection.rollback();
      return res.status(400).json({ 
        message: 'ออเดอร์นี้ไม่สามารถรับได้หรือถูกรับไปแล้ว' 
      });
    }

    const [result] = await connection.query(
      'UPDATE orders SET rider_id = ?, status = 2 WHERE id = ?',
      [riderId, orderId]
    );

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(400).json({ message: 'ไม่สามารถอัปเดตออเดอร์ได้' });
    }

    const [updatedRows] = await connection.query(
      `SELECT o.*, 
              sa.id AS senderAddressId, sa.address_name AS senderAddressName, sa.address_detail AS senderAddressDetail, sa.latitude AS senderLat, sa.longitude AS senderLng,
              ra.id AS receiverAddressId, ra.address_name AS receiverAddressName, ra.address_detail AS receiverAddressDetail, ra.latitude AS receiverLat, ra.longitude AS receiverLng,
              r.name AS receiverName, r.phone AS receiverPhone
       FROM orders o
       JOIN user_addresses sa ON o.sender_address_id = sa.id
       JOIN user_addresses ra ON o.receiver_address_id = ra.id
       JOIN users r ON o.receiver_id = r.id
       WHERE o.id = ?`,
      [orderId]
    );

    if (updatedRows.length === 0) {
      await connection.rollback();
      return res.status(500).json({ message: 'ไม่สามารถดึงข้อมูลออเดอร์ที่อัปเดตได้' });
    }

    const order = updatedRows[0];
    order.senderAddress = {
      id: order.senderAddressId,
      address_name: order.senderAddressName || 'ไม่ระบุ',
      address_detail: order.senderAddressDetail || 'ไม่มีข้อมูล',
      latitude: parseFloat(order.senderLat) || 0.0,
      longitude: parseFloat(order.senderLng) || 0.0,
    };
    order.receiverAddress = {
      id: order.receiverAddressId,
      address_name: order.receiverAddressName || 'ไม่ระบุ',
      address_detail: order.receiverAddressDetail || 'ไม่มีข้อมูล',
      latitude: parseFloat(order.receiverLat) || 0.0,
      longitude: parseFloat(order.receiverLng) || 0.0,
    };
    order.product_image_url = toFileUrl(order.product_image_url) || '';
    order.pickup_image_url = toFileUrl(order.pickup_image_url) || '';
    order.delivery_image_url = toFileUrl(order.delivery_image_url) || '';

    await connection.commit();
    res.status(200).json(order);
  } catch (err) {
    console.error('Accept order error:', err);
    if (connection) await connection.rollback();
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์', error: err.message });
  } finally {
    if (connection) connection.release();
    console.log('Accept order response time:', stopwatch.elapsedMilliseconds, 'ms');
  }
});

// Upload order image
app.post('/upload-order-image', tempStorage.single('productImage'), async (req, res) => {
  const stopwatch = Stopwatch();
  try {
    const { orderId, riderId } = req.body;
    if (!req.file) {
      return res.status(400).json({ message: 'ไม่มีรูปภาพ' });
    }

    const filePath = req.file.path;
    const result = await cloudinary.uploader.upload(filePath, {
      folder: 'mobile_final',
      allowed_formats: ['jpg', 'png', 'jpeg'],
      transformation: [{ width: 500, height: 500, crop: 'limit' }, { quality: 'auto', fetch_format: 'auto' }],
    });
    const fileUrl = result.secure_url;
    await fs.unlink(filePath);

    const [resultUpdate] = await db.query(
      'UPDATE orders SET product_image_url = ? WHERE id = ? AND rider_id = ?',
      [fileUrl, orderId, riderId]
    );

    if (resultUpdate.affectedRows === 0) {
      return res.status(400).json({ message: 'ออเดอร์ไม่พบหรือไม่ถูกมอบหมายให้ไรเดอร์' });
    }

    const [updatedOrder] = await db.query(
      `SELECT o.*, 
              sa.id AS senderAddressId, sa.address_name AS senderAddressName, sa.address_detail AS senderAddressDetail, sa.latitude AS senderLat, sa.longitude AS senderLng,
              ra.id AS receiverAddressId, ra.address_name AS receiverAddressName, ra.address_detail AS receiverAddressDetail, ra.latitude AS receiverLat, ra.longitude AS receiverLng,
              r.name AS receiverName, r.phone AS receiverPhone
       FROM orders o
       JOIN user_addresses sa ON o.sender_address_id = sa.id
       JOIN user_addresses ra ON o.receiver_address_id = ra.id
       JOIN users r ON o.receiver_id = r.id
       WHERE o.id = ?`,
      [orderId]
    );

    if (updatedOrder.length === 0) {
      return res.status(400).json({ message: 'ออเดอร์ไม่พบ' });
    }

    const order = updatedOrder[0];
    order.senderAddress = {
      id: order.senderAddressId,
      address_name: order.senderAddressName || 'ไม่ระบุ',
      address_detail: order.senderAddressDetail || 'ไม่มีข้อมูล',
      latitude: parseFloat(order.senderLat) || 0.0,
      longitude: parseFloat(order.senderLng) || 0.0,
    };
    order.receiverAddress = {
      id: order.receiverAddressId,
      address_name: order.receiverAddressName || 'ไม่ระบุ',
      address_detail: row.receiverAddressDetail || 'ไม่มีข้อมูล',
      latitude: parseFloat(row.receiverLat) || 0.0,
      longitude: parseFloat(row.receiverLng) || 0.0,
    };
    order.product_image_url = toFileUrl(order.product_image_url) || '';
    order.pickup_image_url = toFileUrl(order.pickup_image_url) || '';
    order.delivery_image_url = toFileUrl(order.delivery_image_url) || '';

    res.status(200).json(order);
  } catch (err) {
    console.error('Upload order image error:', err);
    if (req.file) await fs.unlink(req.file.path).catch(() => {});
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์', error: err.message });
  } finally {
    console.log('Upload order image response time:', stopwatch.elapsedMilliseconds, 'ms');
  }
});

// Get rider profile
app.get('/get-rider-profile/:riderId', async (req, res) => {
  try {
    const riderId = req.params.riderId;
    const [users] = await db.query(
      'SELECT id, name, phone, vehicle_reg, vehicle_image_url FROM users WHERE id = ? AND role = 1',
      [riderId]
    );
    if (users.length === 0) {
      return res.status(404).json({ message: 'ไม่พบไรเดอร์' });
    }
    const user = users[0];
    user.vehicle_image_url = toFileUrl(user.vehicle_image_url) || '';
    res.status(200).json(user);
  } catch (err) {
    console.error('Get rider profile error:', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์', error: err.message });
  }
});

// Search user addresses
app.get('/search-user-addresses', async (req, res) => {
  const stopwatch = Stopwatch();
  try {
    const phone = req.query.phone;
    const [users] = await db.query('SELECT * FROM users WHERE phone = ?', [phone]);
    if (!users[0]) {
      return res.status(404).json({ message: 'ไม่พบผู้ใช้' });
    }
    const user = users[0];
    const [addresses] = await db.query('SELECT * FROM user_addresses WHERE user_id = ?', [user.id]);
    res.status(200).json({ user, addresses });
  } catch (err) {
    console.error('Search user addresses error:', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์', error: err.message });
  } finally {
    console.log('Search user addresses response time:', stopwatch.elapsedMilliseconds, 'ms');
  }
});

// Create order
app.post('/create-order', tempStorage.single('productImage'), async (req, res) => {
  const stopwatch = Stopwatch();
  try {
    const { senderId, senderAddressId, receiverPhone, receiverAddressId, productDetails, status } = req.body;
    if (!req.file) {
      return res.status(400).json({ message: 'ต้องอัปโหลดรูปภาพสินค้า' });
    }

    const filePath = req.file.path;
    const result = await cloudinary.uploader.upload(filePath, {
      folder: 'mobile_final',
      allowed_formats: ['jpg', 'png', 'jpeg'],
      transformation: [{ width: 500, height: 500, crop: 'limit' }, { quality: 'auto', fetch_format: 'auto' }],
    });
    const fileUrl = result.secure_url;
    await fs.unlink(filePath);

    const [receiverRows] = await db.query('SELECT id, name FROM users WHERE phone = ?', [receiverPhone]);
    if (receiverRows.length === 0) {
      return res.status(404).json({ message: 'ไม่พบผู้รับ' });
    }
    const receiverId = receiverRows[0].id;

    const [senderAddress] = await db.query('SELECT id FROM user_addresses WHERE id = ?', [senderAddressId]);
    if (senderAddress.length === 0) {
      return res.status(400).json({ message: 'ที่อยู่ผู้ส่งไม่ถูกต้อง' });
    }

    const [receiverAddress] = await db.query('SELECT id FROM user_addresses WHERE id = ?', [receiverAddressId]);
    if (receiverAddress.length === 0) {
      return res.status(400).json({ message: 'ที่อยู่ผู้รับไม่ถูกต้อง' });
    }

    const [resultInsert] = await db.query(
      'INSERT INTO orders (sender_id, sender_address_id, receiver_id, receiver_address_id, product_details, product_image_url, status, rider_id) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)',
      [senderId, senderAddressId, receiverId, receiverAddressId, productDetails || '', fileUrl, status || 1]
    );

    const [orders] = await db.query(
      `SELECT o.*, 
              s.name AS senderName, 
              sa.id AS senderAddressId, sa.address_name AS senderAddressName, sa.address_detail AS senderAddressDetail, sa.latitude AS senderLat, sa.longitude AS senderLng,
              r.name AS receiverName, r.phone AS receiverPhone, 
              ra.id AS receiverAddressId, ra.address_name AS receiverAddressName, ra.address_detail AS receiverAddressDetail, ra.latitude AS receiverLat, ra.longitude AS receiverLng
       FROM orders o
       JOIN users s ON o.sender_id = s.id
       JOIN user_addresses sa ON o.sender_address_id = sa.id
       JOIN users r ON o.receiver_id = r.id
       JOIN user_addresses ra ON o.receiver_address_id = ra.id
       WHERE o.id = ?`,
      [resultInsert.insertId]
    );

    if (orders.length === 0) {
      return res.status(400).json({ message: 'ออเดอร์ไม่พบ' });
    }

    const order = orders[0];
    order.senderAddress = {
      id: order.senderAddressId,
      address_name: order.senderAddressName || 'ไม่ระบุ',
      address_detail: order.senderAddressDetail || 'ไม่มีข้อมูล',
      latitude: parseFloat(order.senderLat) || 0.0,
      longitude: parseFloat(order.senderLng) || 0.0,
    };
    order.receiverAddress = {
      id: order.receiverAddressId,
      address_name: order.receiverAddressName || 'ไม่ระบุ',
      address_detail: order.receiverAddressDetail || 'ไม่มีข้อมูล',
      latitude: parseFloat(order.receiverLat) || 0.0,
      longitude: parseFloat(order.receiverLng) || 0.0,
    };
    order.product_image_url = toFileUrl(order.product_image_url) || '';
    order.pickup_image_url = toFileUrl(order.pickup_image_url) || '';
    order.delivery_image_url = toFileUrl(order.delivery_image_url) || '';

    // แจ้งเตือนงานใหม่ผ่าน WebSocket
    clients.forEach((clientSet, riderId) => {
      clientSet.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ event: 'new_order', orderId: resultInsert.insertId }));
        }
      });
    });

    res.status(200).json(order);
  } catch (err) {
    console.error('Create order error:', err);
    if (req.file) await fs.unlink(req.file.path).catch(() => {});
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์', error: err.message });
  } finally {
    console.log('Create order response time:', stopwatch.elapsedMilliseconds, 'ms');
  }
});

// Update rider location
app.post('/update-rider-location', async (req, res) => {
  try {
    const { riderId, latitude, longitude } = req.body;
    await db.query(
      'INSERT INTO rider_locations (rider_id, latitude, longitude) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE latitude = ?, longitude = ?, updated_at = CURRENT_TIMESTAMP',
      [riderId, latitude, longitude, latitude, longitude]
    );
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Update rider location error:', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์', error: err.message });
  }
});

// Get rider location
app.get('/get-rider-location/:riderId', async (req, res) => {
  try {
    const riderId = req.params.riderId;
    const [rows] = await db.query(
      'SELECT latitude, longitude FROM rider_locations WHERE rider_id = ? ORDER BY updated_at DESC LIMIT 1',
      [riderId]
    );

    if (rows.length > 0) {
      res.status(200).json(rows[0]);
    } else {
      res.status(200).json({ latitude: 0.0, longitude: 0.0 });
    }
  } catch (err) {
    console.error('Get rider location error:', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์', error: err.message });
  }
});

// Get all orders
app.get('/get-orders-all', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT o.*, sa.address_name AS senderAddressName, ra.address_name AS receiverAddressName, r.name AS receiverName, r.phone AS receiverPhone FROM orders o JOIN user_addresses sa ON o.sender_address_id = sa.id JOIN user_addresses ra ON o.receiver_address_id = ra.id JOIN users r ON o.receiver_id = r.id WHERE o.status BETWEEN 1 AND 4 ORDER BY o.id DESC'
    );
    const formattedRows = rows.map(row => ({
      ...row,
      product_image_url: toFileUrl(row.product_image_url) || '',
      pickup_image_url: toFileUrl(row.pickup_image_url) || '',
      delivery_image_url: toFileUrl(row.delivery_image_url) || '',
    }));
    res.status(200).json(formattedRows);
  } catch (err) {
    console.error('Get all orders error:', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์', error: err.message });
  }
});

// Get orders for receiver map
app.get('/get-orders-receiver', async (req, res) => {
  try {
    const { userId } = req.query;
    const [rows] = await db.query(
      `SELECT o.*, 
              sa.id AS senderAddressId, sa.address_name AS senderAddressName, sa.address_detail AS senderAddressDetail, sa.latitude AS senderLat, sa.longitude AS senderLng,
              ra.id AS receiverAddressId, ra.address_name AS receiverAddressName, ra.address_detail AS receiverAddressDetail, ra.latitude AS receiverLat, ra.longitude AS receiverLng,
              rd.name AS rider_name, rd.phone AS rider_phone
       FROM orders o
       JOIN user_addresses sa ON o.sender_address_id = sa.id
       JOIN user_addresses ra ON o.receiver_address_id = ra.id
       LEFT JOIN users rd ON o.rider_id = rd.id
       WHERE o.receiver_id = ? AND o.status BETWEEN 1 AND 4
       ORDER BY o.id DESC`,
      [userId]
    );

    const formattedRows = rows.map(row => ({
      ...row,
      senderAddress: {
        id: row.senderAddressId,
        address_name: row.senderAddressName || 'ไม่ระบุ',
        address_detail: row.senderAddressDetail || 'ไม่มีข้อมูล',
        latitude: parseFloat(row.senderLat) || 0.0,
        longitude: parseFloat(row.senderLng) || 0.0,
      },
      receiverAddress: {
        id: row.receiverAddressId,
        address_name: row.receiverAddressName || 'ไม่ระบุ',
        address_detail: row.receiverAddressDetail || 'ไม่มีข้อมูล',
        latitude: parseFloat(row.receiverLat) || 0.0,
        longitude: parseFloat(row.receiverLng) || 0.0,
      },
      product_image_url: toFileUrl(row.product_image_url) || '',
      pickup_image_url: toFileUrl(row.pickup_image_url) || '',
      delivery_image_url: toFileUrl(row.delivery_image_url) || '',
    }));

    res.status(200).json(formattedRows);
  } catch (err) {
    console.error('Get receiver map orders error:', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์', error: err.message });
  }
});

// Get users
app.get('/get-users', async (req, res) => {
  const stopwatch = Stopwatch();
  try {
    const [users] = await db.query(
      'SELECT id, name, phone, profile_image_url AS image_url FROM users WHERE role = 0'
    );
    const formattedUsers = users.map(user => ({
      ...user,
      image_url: toFileUrl(user.image_url) || '',
    }));
    res.status(200).json(formattedUsers);
  } catch (err) {
    console.error('Get users error:', err);
    res.status(500).json({ message: 'เกิดข้อผิดพลาดในเซิร์ฟเวอร์', error: err.message });
  } finally {
    console.log('Get users response time:', stopwatch.elapsedMilliseconds, 'ms');
  }
});

// Stopwatch utility
function Stopwatch() {
  let startTime = Date.now();
  return {
    elapsedMilliseconds: () => Date.now() - startTime,
  };
}