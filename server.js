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

function buildDtvCanonicalUrl(serviceLabel, rawPhoneName) {
    const serviceSlug = getDtvServiceSlug(serviceLabel);
    const cleanPhone = cleanPhoneName(rawPhoneName);
    const phoneSlug = removeAccents(cleanPhone).toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
    return 'https://dienthoaivui.com.vn/' + serviceSlug + '-' + phoneSlug;
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

// LẤY LINH KIỆN TỪ RENDER API VÀ ĐÁNH DẤU CÓ GIÁ SẴN
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

        if (response && response.data && response.data.items) {
            const items = response.data.items.map(item => {
                const p = parseFloat(item.raw_price || item.price || item.deduction || 0);
                return {
                    ...item,
                    raw_price: p,
                    isFromRender: p > 0 // Đánh dấu giá đến từ Render API
                };
            });
            return res.json({ items });
        }

        res.json({ items: [] });
    } catch (error) {
        res.json({ items: [] });
    }
});

// AI TRA GIÁ BÙ KHI RENDER API THIẾU GIÁ
async function askGeminiToExtractPrice(pageTextContent, serviceName, phoneName) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return { rawPrice: 0, selectedBrand: "" };

    const prompt = `Bạn là bộ phân tích bảng giá linh kiện Điện Thoại Vui. Hãy tìm GIÁ NIÊM YẾT GỐC (số nguyên) cho dịch vụ ${serviceName} trên máy ${phoneName}.
NỘI DUNG TRANG WEB: ${pageTextContent.substring(0, 12000)}
Trả về duy nhất JSON: {"rawPrice": <số_tiền_nguyên>, "selectedBrand": "<tên_dịch_vụ>"}`;

    try {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
        const res = await axios.post(geminiUrl, {
            contents: [{ parts: [{ text: prompt }] }]
        }, { timeout: 10000 });

        let resultText = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        resultText = resultText.replace(/```json/gi, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(resultText);
        return { rawPrice: Number(parsed.rawPrice) || 0, selectedBrand: parsed.selectedBrand || serviceName };
    } catch (e) {
        return { rawPrice: 0, selectedBrand: "" };
    }
}

app.get('/api/get-dtv-price', async (req, res) => {
    const { service, phone } = req.query;
    if (!service || !phone) return res.json({ success: false, rawPrice: 0 });

    const cleanPhone = cleanPhoneName(phone);
    const dtvUrl = buildDtvCanonicalUrl(service, cleanPhone);

    try {
        const responseHtml = await axios.get(dtvUrl, { headers: DTV_HEADERS, timeout: 8000 });
        const ch = cheerio.load(responseHtml.data);
        ch('script, style, svg, iframe, nav, footer').remove();
        const pageText = ch('body').text().replace(/\s+/g, ' ').trim();

        if (!pageText.includes('Cloudflare') && pageText.length > 100) {
            const extracted = await askGeminiToExtractPrice(pageText, service, cleanPhone);
            if (extracted && extracted.rawPrice > 0) {
                return res.json({
                    success: true,
                    url: dtvUrl,
                    selectedBrand: extracted.selectedBrand || service,
                    rawPrice: extracted.rawPrice
                });
            }
        }
    } catch (error) {}

    return res.json({ success: false, rawPrice: 0, url: dtvUrl });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Server Backend AI đang chạy tại port: ' + PORT));