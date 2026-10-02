require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(cors());
app.use(express.json());

const RENDER_BASE_URL = 'https://tra-gia-nhap-cu.onrender.com';

const DTV_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': 'https://dienthoaivui.com.vn'
};

function removeAccents(str) {
    if (!str) return "";
    return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

function cleanPhoneName(phoneRaw) {
    if (!phoneRaw) return "";
    return phoneRaw
        .replace(/^(APPLE|SAMSUNG|XIAOMI|OPPO|VIVO|REALME|ASUS|GOOGLE)\s+/i, '')
        .replace(/\s*\d+\s*(GB|TB)$/i, '')
        .trim();
}

// Chuẩn hóa Slug URL chính xác theo Điện Thoại Vui
function getDtvServiceSlug(label) {
    if (!label) return 'thay-linh-kien';
    const l = removeAccents(label).toLowerCase().trim();
    
    if (l.includes('face id') || l.includes('faceid')) return 'sua-face-id';
    if (l.includes('man') || l.includes('man hinh')) return 'thay-man-hinh';
    if (l.includes('pin')) return 'thay-pin';
    if (l.includes('kinh lung') || l.includes('mat lung') || l.includes('nap lung')) return 'thay-kinh-lung';
    if (l.includes('cam ung') || l.includes('kinh cam ung')) return 'thay-kinh-cam-ung';
    if (l.includes('ep kinh') || l.includes('mat kinh') || l.includes('kinh')) return 'thay-mat-kinh';
    if (l.includes('vo')) return 'thay-vo';
    if (l.includes('cam sau') || l.includes('camera sau')) return 'thay-camera-sau';
    if (l.includes('cam truoc') || l.includes('camera truoc')) return 'thay-camera-truoc';
    if (l.includes('loa ngoai')) return 'thay-loa-ngoai';
    if (l.includes('loa trong')) return 'thay-loa-trong';
    if (l.includes('chan sac') || l.includes('cap sac')) return 'thay-cap-chan-sac';
    
    return 'thay-' + l.replace(/[^a-z0-9]/g, '-');
}

function buildDtvUrls(serviceLabel, rawPhoneName) {
    const serviceSlug = getDtvServiceSlug(serviceLabel);
    const cleanPhone = cleanPhoneName(rawPhoneName);
    const phoneSlug = removeAccents(cleanPhone).toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
    
    const primary = `https://dienthoaivui.com.vn/${serviceSlug}-${phoneSlug}`;
    
    // Tạo URL dự phòng nếu trang bị 404 (ví dụ: sua-loi-face-id vs sua-face-id)
    let fallback = null;
    if (serviceSlug === 'sua-face-id') {
        fallback = `https://dienthoaivui.com.vn/sua-loi-face-id-${phoneSlug}`;
    } else if (serviceSlug === 'thay-cap-chan-sac') {
        fallback = `https://dienthoaivui.com.vn/thay-chan-sac-${phoneSlug}`;
    } else if (serviceSlug === 'thay-mat-kinh') {
        fallback = `https://dienthoaivui.com.vn/ep-kinh-${phoneSlug}`;
    }

    return { primary, fallback };
}

// Bóc tách giá chính xác từ HTML/JSON-LD Điện Thoại Vui mà KHÔNG CẦN GEMINI AI
function extractPriceFromHtml(html) {
    const $ = cheerio.load(html);
    
    // 1. Thử bóc tách từ dữ liệu JSON-LD Schema
    let exactPrice = 0;
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const data = JSON.parse($(el).html());
            if (data.price) exactPrice = parseInt(data.price, 10);
            if (!exactPrice && data.offers && data.offers.price) exactPrice = parseInt(data.offers.price, 10);
            if (!exactPrice && Array.isArray(data) && data[0]?.offers?.price) exactPrice = parseInt(data[0].offers.price, 10);
        } catch (e) {}
    });

    if (exactPrice > 0) return exactPrice;

    // 2. Thử bóc tách từ class giá hiển thị trên giao diện DTV
    const priceSelectors = ['.price-show', '.price-current', '.product-price', '.price', '.special-price'];
    for (const selector of priceSelectors) {
        const text = $(selector).first().text().replace(/[^\d]/g, '');
        if (text) {
            const parsed = parseInt(text, 10);
            if (parsed >= 50000 && parsed <= 50000000) return parsed;
        }
    }

    // 3. Fallback Regex tìm số tiền dạng xxx.xxx đ
    $('script, style, iframe, nav, footer').remove();
    const bodyText = $('body').text();
    const match = bodyText.match(/(\d{1,3}(?:\.\d{3})+)\s*đ/);
    if (match && match[1]) {
        const parsed = parseInt(match[1].replace(/\./g, ''), 10);
        if (parsed >= 50000 && parsed <= 50000000) return parsed;
    }

    return 0;
}

app.get('/api/phones', async (req, res) => {
    try {
        const keyword = req.query.q || '';
        const cleanKeyword = keyword.replace(/^(APPLE|SAMSUNG|XIAOMI|OPPO|VIVO|REALME|ASUS|GOOGLE)\s+/i, '').trim();
        const targetUrl = RENDER_BASE_URL + '/api/search?q=' + encodeURIComponent(cleanKeyword || keyword);
        
        const response = await axios.get(targetUrl, { timeout: 15000 });
        res.json(response.data.products || []);
    } catch (error) {
        res.status(500).json({ error: 'Không thể lấy dữ liệu điện thoại', message: error.message });
    }
});

app.get('/api/repairs', async (req, res) => {
    try {
        const rawName = req.query.name || '';
        if (!rawName) return res.status(400).json({ error: 'Thiếu tên sản phẩm' });

        const cleanName = rawName.replace(/^(APPLE|SAMSUNG|XIAOMI|OPPO|VIVO|REALME|ASUS|GOOGLE)\s+/i, '').trim();
        let targetUrl = RENDER_BASE_URL + '/api/repair-prices?product_name=' + encodeURIComponent(cleanName);
        
        let response = await axios.get(targetUrl, { timeout: 15000 }).catch(() => null);

        if (!response || !response.data || !response.data.items || response.data.items.length === 0) {
            const noStorageName = cleanName.replace(/\s*\d+\s*(GB|TB)$/i, '').trim();
            if (noStorageName && noStorageName !== cleanName) {
                targetUrl = RENDER_BASE_URL + '/api/repair-prices?product_name=' + encodeURIComponent(noStorageName);
                const secondTry = await axios.get(targetUrl, { timeout: 15000 }).catch(() => null);
                if (secondTry && secondTry.data && secondTry.data.items && secondTry.data.items.length > 0) {
                    response = secondTry;
                }
            }
        }

        if (response && response.data) {
            return res.json(response.data);
        }

        res.json({ items: [] });
    } catch (error) {
        res.json({ items: [] });
    }
});

app.get('/api/get-dtv-price', async (req, res) => {
    const { service, phone } = req.query;
    if (!service || !phone) return res.json({ success: false, rawPrice: 0 });

    const { primary, fallback } = buildDtvUrls(service, phone);

    let targetUrl = primary;
    let responseHtml = null;

    try {
        responseHtml = await axios.get(primary, { headers: DTV_HEADERS, timeout: 7000 });
    } catch (err) {
        if (fallback) {
            try {
                targetUrl = fallback;
                responseHtml = await axios.get(fallback, { headers: DTV_HEADERS, timeout: 7000 });
            } catch (e) {}
        }
    }

    if (responseHtml && responseHtml.data) {
        const rawPrice = extractPriceFromHtml(responseHtml.data);
        if (rawPrice > 0) {
            return res.json({
                success: true,
                rawPrice: rawPrice,
                url: targetUrl
            });
        }
    }

    return res.json({ success: false, rawPrice: 0, url: targetUrl });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log('Server Backend AI đang chạy tại port: ' + PORT);
});