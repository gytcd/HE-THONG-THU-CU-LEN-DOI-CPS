const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());

const BASE_URL = 'https://tra-gia-nhap-cu.onrender.com';

// 1. API Tìm kiếm điện thoại & lấy giá Loại 1, 2, 3...
app.get('/api/phones', async (req, res) => {
    try {
        const keyword = req.query.q || '';
        const targetUrl = `${BASE_URL}/api/search?q=${encodeURIComponent(keyword)}`;
        const response = await axios.get(targetUrl);
        
        // Trả về mảng danh sách điện thoại
        res.json(response.data.products || []);
    } catch (error) {
        console.error("Lỗi lấy danh sách máy:", error.message);
        res.status(500).json({ error: 'Không thể lấy dữ liệu điện thoại' });
    }
});

// 2. API MỚI: Lấy bảng giá trừ tiền lỗi linh kiện theo tên máy
app.get('/api/repairs', async (req, res) => {
    try {
        const productName = req.query.name;
        if (!productName) {
            return res.status(400).json({ error: 'Thiếu tên sản phẩm' });
        }

        const targetUrl = `${BASE_URL}/api/repair-prices?product_name=${encodeURIComponent(productName)}`;
        const response = await axios.get(targetUrl);
        
        // Trả về danh sách các lỗi và số tiền bị trừ tương ứng
        res.json(response.data);
    } catch (error) {
        console.error("Lỗi lấy bảng giá sửa chữa:", error.message);
        res.status(500).json({ error: 'Không thể lấy dữ liệu linh kiện' });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server Backend đang chạy tại: http://localhost:${PORT}`);
    console.log(`- API Giá máy: http://localhost:${PORT}/api/phones?q=iphone`);
    console.log(`- API Trừ lỗi: http://localhost:${PORT}/api/repairs?name=APPLE IPHONE 17 PRO MAX 256GB`);
});