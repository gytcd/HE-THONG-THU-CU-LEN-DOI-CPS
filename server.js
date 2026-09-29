require('dotenv').config(); // 🌟 Luôn đặt trên cùng để nạp biến môi trường từ file .env
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenAI } = require('@google/genai'); // Sử dụng SDK chính thức mới của Google

const app = express();
app.use(cors());
app.use(express.json());

// 🌟 Hệ thống tự động nhận diện khóa bảo mật GEMINI_API_KEY từ file .env hoặc môi trường hosting
const ai = new GoogleGenAI(); 

const RENDER_BASE_URL = 'https://onrender.com';

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

// BỘ LỌC TÊN MÁY: XÓA CHỮ APPLE / SAMSUNG / XIAOMI... VÀ DUNG LƯỢNG GB/TB
function cleanPhoneName(phoneRaw) {
    if (!phoneRaw) return "";
    return phoneRaw
        .replace(/^(APPLE|SAMSUNG|XIAOMI|OPPO|VIVO|REALME|ASUS|GOOGLE)\s+/i, '')
        .replace(/\s*\d+\s*(GB|TB)\$/i, '')
        .trim();
}

function getDtvServiceSlug(label) {
    if (!label) return 'thay-linh-kien';
    const l = removeAccents(label).toLowerCase().trim();
    
    if (l.includes('face id') || l.includes('faceid')) return 'sua-loi-face-id';
    if (l.includes('man') || l.includes('man hinh')) return 'thay-man-hinh';
    if (l.includes('pin')) return 'thay-pin';
    if (l.includes('kinh lung') || l.includes('mat lung') || l.includes('nap lung')) return 'thay-kinh-lung';
    if (l.includes('cam ung') || l.includes('kinh cam ung')) return 'thay-kinh-cam-ung';
    if (l.includes('ep kinh') || l.includes('mat kinh') || l.includes('kinh')) return 'ep-kinh';
    if (l.includes('vo')) return 'thay-vo';
    if (l.includes('cam sau') || l.includes('camera sau')) return 'thay-camera-sau';
    if (l.includes('cam truoc') || l.includes('camera truoc')) return 'thay-camera-truoc';
    if (l.includes('loa ngoai')) return 'thay-loa-ngoai';
    if (l.includes('loa trong')) return 'thay-loa-trong';
    if (l.includes('chan sac') || l.includes('cap sac')) return 'thay-chan-sac';
    
    return 'thay-' + l.replace(/[^a-z0-9]/g, '-');
}

function buildDtvCanonicalUrl(serviceLabel, rawPhoneName) {
    const serviceSlug = getDtvServiceSlug(serviceLabel);
    const cleanPhone = cleanPhoneName(rawPhoneName);
    const phoneSlug = removeAccents(cleanPhone).toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
    return `https://dienthoaivui.com.vn${serviceSlug}-${phoneSlug}`;
}

// 1. API Tìm kiếm điện thoại & lấy giá Loại 1, 2, 3...
app.get('/api/phones', async (req, res) => {
    try {
        const keyword = req.query.q || '';
        const targetUrl = `${RENDER_BASE_URL}/api/search?q=${encodeURIComponent(keyword)}`;
        const response = await axios.get(targetUrl);
        res.json(response.data.products || []);
    } catch (error) {
        console.error("Lỗi lấy danh sách điện thoại:", error.message);
        res.status(500).json({ error: 'Không thể lấy dữ liệu điện thoại' });
    }
});

// 2. API Lấy bảng giá trừ tiền lỗi linh kiện theo tên máy
app.get('/api/repairs', async (req, res) => {
    try {
        const productName = req.query.name;
        if (!productName) return res.status(400).json({ error: 'Thiếu tên sản phẩm' });

        const targetUrl = `${RENDER_BASE_URL}/api/repair-prices?product_name=${encodeURIComponent(productName)}`;
        const response = await axios.get(targetUrl);
        res.json(response.data);
    } catch (error) {
        console.error("Lỗi lấy dữ liệu linh kiện:", error.message);
        res.status(500).json({ error: 'Không thể lấy dữ liệu linh kiện' });
    }
});

// 3. TRÍCH XUẤT GIÁ BẰNG GEMINI AI SDK MỚI
async function askGeminiToExtractPrice(pageTextContent, serviceName, phoneName) {
    const isIphone = phoneName.toUpperCase().includes('IPHONE');
    const prompt = `
Bạn là bộ phân tích bảng giá linh kiện Điện Thoại Vui.
Hãy tìm GIÁ NIÊM YẾT GỐC (chưa giảm, chưa trừ Smember, chưa trừ voucher/chiết khấu) cho dịch vụ "${serviceName}" trên máy "${phoneName}".

NỘI DUNG TRANG WEB:
"""
${pageTextContent.substring(0, 15000)}
"""

QUY TẮC ƯU TIÊN LINH KIỆN:
1. Lấy giá gốc niêm yết của linh kiện chuẩn (chưa qua giảm giá).
2. Quy tắc thương hiệu:
   - Pin: ${isIphone ? 'Ưu tiên Dung lượng chuẩn Pisen > Dung lượng chuẩn Gen A/GenA > Dung lượng chuẩn Vmas > các dòng pin khác (chọn loại có giá thấp nhất).' : 'Ưu tiên linh kiện chuẩn chính hãng.'}
   - Camera trước iPhone: Ưu tiên loại "Giữ Face ID".
   - Camera sau iPhone: Ưu tiên loại "GEN A".
   - Màn hình iPhone: Ưu tiên loại "MÀN GEN A PRO" (GEN A Pro).
3. Trả về DUY NHẤT định dạng JSON thuần (KHÔNG DÙNG BLOCK MARKDOWN):
{"rawPrice": <số nguyên giá gốc, VD: 840000>, "selectedBrand": "<tên linh kiện>"}
Nếu không tìm thấy, trả về: {"rawPrice": 0, "selectedBrand": ""}
`;

    try {
        // Gọi API bằng SDK mới thế hệ hai của Google, tối ưu cho Auth Key (đầu mã AQ.)
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash', 
            contents: prompt,
        });

        let resultText = response.text || '';
        resultText = resultText.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(resultText);
    } catch (e) {
        console.error("Lỗi Gemini SDK:", e.message);
        return { rawPrice: 0, selectedBrand: "" };
    }
}

// 4. API TRA GIÁ DTV BẰNG GEMINI API
app.get('/api/get-dtv-price', async (req, res) => {
    const { service, phone } = req.query;
    if (!service || !phone) return res.status(400).json({ success: false, rawPrice: 0 });

    const cleanPhone = cleanPhoneName(phone);
    const dtvUrl = buildDtvCanonicalUrl(service, cleanPhone);

    try {
        const { data: html } = await axios.get(dtvUrl, { headers: DTV_HEADERS, timeout: 8000 });
        const \(= cheerio.load(html);\)('script, style, svg, iframe, nav, footer').remove();
        const pageText = \$('body').text().replace(/\s+/g, ' ').trim();

        // Kiểm tra rào cản Cloudflare chống bot
        if (pageText.includes('Cloudflare') || pageText.includes('Verify you are human') || pageText.length < 100) {
            console.warn(`[CHẶN BOT] DTV chặn cào URL: ${dtvUrl}`);
            return res.json({
                success: false,
                rawPrice: 0,
                url: dtvUrl,
                message: 'Bị rào cản Cloudflare chống bot chặn cào dữ liệu'
            });
        }

        const extracted = await askGeminiToExtractPrice(pageText, service, cleanPhone);

        if (extracted && extracted.rawPrice > 0) {
            return res.json({
                success: true,
                url: dtvUrl,
                selectedBrand: extracted.selectedBrand || service,
                rawPrice: extracted.rawPrice
            });
        }
    } catch (error) {
        console.error(`Lỗi cào URL ${dtvUrl}:`, error.message);
    }

    return res.json({
        success: false,
        rawPrice: 0,
        url: dtvUrl,
        message: 'Không tìm thấy trang dịch vụ hoặc lỗi cào dữ liệu'
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server Backend AI đang chạy tại port: ${PORT}`);
});